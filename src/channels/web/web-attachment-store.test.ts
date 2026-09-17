/**
 * Plan 2.8 (the durable form of 0-A.4): an attachment link must still resolve
 * after the daemon restarts. The records used to live in a Map, so every
 * `/attachments/<token>` URL in the history — including the ones the reconnect
 * replay re-sends — answered 404 the moment the process was replaced.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { WebAttachmentStore } from "./web-attachment-store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "web-attachments-"));
  dirs.push(dir);
  return join(dir, "web-attachments.db");
}

describe("WebAttachmentStore", () => {
  it("keeps bytes and paths across a restart of the process", () => {
    const path = dbPath();
    const first = new WebAttachmentStore(path);
    const bytes = Buffer.from("89504e470d0a1a0a", "hex");
    const imageToken = first.register({ name: "frame.png", mimeType: "image/png", data: bytes, chatId: "chat-1" });
    const missing = join(dirname(path), "HOW_TO_RUN.md");
    const fileToken = first.register({ name: "HOW_TO_RUN.md", path: missing });
    first.close();

    // A new process — the link in the chat history must still work.
    const second = new WebAttachmentStore(path);
    expect(second.get(imageToken)).toMatchObject({ name: "frame.png", mimeType: "image/png", chatId: "chat-1" });
    expect(second.get(imageToken)!.data).toEqual(bytes);
    expect(second.get(fileToken)).toMatchObject({ name: "HOW_TO_RUN.md", path: missing });
    // A path whose bytes were never captured is not servable (round 9 #24).
    expect(second.verifyStoredFile(second.get(fileToken)!)).toBe(false);
    expect(second.get("nope")).toBeNull();
    second.close();
  });

  it("forgets a record once its time is up (guard)", () => {
    const store = new WebAttachmentStore(dbPath(), -1);
    const token = store.register({ name: "gone.png", data: Buffer.from("x") });
    expect(store.get(token)).toBeNull();
    expect(store.size()).toBe(0);
    store.close();
  });

  it("keeps at most the bound, dropping the oldest first (guard)", () => {
    const store = new WebAttachmentStore(dbPath(), 60_000, 3);
    const tokens = ["a", "b", "c", "d"].map((name) => store.register({ name, data: Buffer.from(name) }));
    expect(store.size()).toBe(3);
    expect(store.get(tokens[0]!)).toBeNull();
    expect(store.get(tokens[3]!)).toMatchObject({ name: "d" });
    store.close();
  });

  it("issues unguessable, distinct tokens", () => {
    const store = new WebAttachmentStore(dbPath());
    const tokens = new Set(Array.from({ length: 50 }, () => store.register({ name: "x", data: Buffer.from("x") })));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    store.close();
  });
});

// =============================================================================
// ROUND 9 #24 — a token owns its BYTES, not a path somebody else can change
//
// The record used to keep the local path and stream whatever was there when the
// link was clicked. After a restart the file could be gone (404 for a message
// that still promises it), replaced by an unrelated file of the same name, or
// swapped for a symlink to something private that serving happily followed.
// =============================================================================
describe("WebAttachmentStore snapshots what the token serves (round 9 #24)", () => {
  function fileWith(content: string, name = "report.md"): string {
    const dir = mkdtempSync(join(tmpdir(), "web-attach-src-"));
    dirs.push(dir);
    const file = join(dir, name);
    writeFileSync(file, content);
    return file;
  }

  it("keeps the bytes of a small file, so deleting the original changes nothing", () => {
    const store = new WebAttachmentStore(dbPath());
    const file = fileWith("# How to run\nOpen Assets/Scenes/Main.unity");
    const token = store.register({ name: "HOW_TO_RUN.md", path: file });
    rmSync(file);
    const entry = store.get(token)!;
    expect(entry.data?.toString()).toBe("# How to run\nOpen Assets/Scenes/Main.unity");
    // The mutable path is not what the token holds any more.
    expect(entry.path).toBeUndefined();
    store.close();
  });

  it("never serves a replacement file left at the same path", () => {
    const store = new WebAttachmentStore(dbPath());
    const file = fileWith("the frame the user was promised");
    const token = store.register({ name: "frame.png", path: file });
    writeFileSync(file, "something else entirely");
    expect(store.get(token)!.data?.toString()).toBe("the frame the user was promised");
    store.close();
  });

  it("never follows a symlink swapped in after registration", () => {
    const store = new WebAttachmentStore(dbPath());
    const file = fileWith("public content");
    const secret = fileWith("PRIVATE-KEY-MATERIAL", "id_rsa");
    const token = store.register({ name: "public.txt", path: file });
    rmSync(file);
    symlinkSync(secret, file);
    const entry = store.get(token)!;
    expect(entry.data?.toString()).toBe("public content");
    expect(entry.path).toBeUndefined();
    store.close();
  });

  it("keeps a large file by reference with a checksum, and refuses it once it changes", () => {
    // 64 bytes is the inline limit here; the real default is 8 MiB.
    const store = new WebAttachmentStore(dbPath(), 60_000, 200, 64);
    const file = fileWith("x".repeat(500), "recording.mp4");
    const token = store.register({ name: "recording.mp4", path: file });
    const entry = store.get(token)!;
    expect(entry.data).toBeUndefined();
    // The REAL path (macOS /var is a symlink to /private/var), resolved once at
    // registration so a later symlink swap cannot redirect the token.
    expect(entry.path).toBe(realpathSync(file));
    expect(entry.sizeBytes).toBe(500);
    expect(entry.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(store.verifyStoredFile(entry)).toBe(true);

    // Same size, different bytes: the checksum is what catches it.
    writeFileSync(file, "y".repeat(500));
    expect(store.verifyStoredFile(store.get(token)!)).toBe(false);
    // Gone entirely.
    rmSync(file);
    expect(store.verifyStoredFile(store.get(token)!)).toBe(false);
    store.close();
  });

  it("refuses a large file whose path became a symlink to something else", () => {
    const store = new WebAttachmentStore(dbPath(), 60_000, 200, 64);
    const file = fileWith("z".repeat(500), "big.bin");
    const secret = fileWith("z".repeat(500), "secret.bin");
    const token = store.register({ name: "big.bin", path: file });
    rmSync(file);
    symlinkSync(secret, file);
    // Same size, same bytes even — but the path is no longer a regular file.
    expect(store.verifyStoredFile(store.get(token)!)).toBe(false);
    expect(readFileSync(secret, "utf-8").length).toBe(500);
    store.close();
  });

  it("survives a restart: the snapshot is in the database, not in the process", () => {
    const db = dbPath();
    const first = new WebAttachmentStore(db);
    const file = fileWith("gameplay frame bytes");
    const token = first.register({ name: "frame.png", path: file });
    first.close();
    rmSync(file);
    const second = new WebAttachmentStore(db);
    expect(second.get(token)!.data?.toString()).toBe("gameplay frame bytes");
    second.close();
  });
});
