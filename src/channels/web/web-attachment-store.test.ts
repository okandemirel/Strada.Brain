/**
 * Plan 2.8 (the durable form of 0-A.4): an attachment link must still resolve
 * after the daemon restarts. The records used to live in a Map, so every
 * `/attachments/<token>` URL in the history — including the ones the reconnect
 * replay re-sends — answered 404 the moment the process was replaced.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { RETAINED_ATTACHMENT_DIR, WebAttachmentStore } from "./web-attachment-store.js";

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

  // ROUND 10 #2: a large file is RETAINED, not referenced. The old assertions
  // here expected the token to be REFUSED once the source changed — which is the
  // defect written down as an expectation: the recording's temp source is deleted
  // by the pipeline that made it, and the link in the chat then 404'd.
  it("retains an immutable private copy of a large file instead of pointing at the source", () => {
    // 64 bytes is the inline limit here; the real default is 8 MiB.
    const store = new WebAttachmentStore(dbPath(), 60_000, 200, 64);
    const file = fileWith("x".repeat(500), "recording.mp4");
    const token = store.register({ name: "recording.mp4", path: file });
    const entry = store.get(token)!;
    expect(entry.data).toBeUndefined();
    // Not the caller's path any more: the store's own copy, named by the token.
    expect(entry.retained).toBe(true);
    expect(entry.path).not.toBe(realpathSync(file));
    expect(entry.path).toContain(RETAINED_ATTACHMENT_DIR);
    expect(entry.path!.endsWith(token)).toBe(true);
    expect(entry.sizeBytes).toBe(500);
    expect(entry.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(entry.path!, "utf-8")).toBe("x".repeat(500));
    // 0600: the copy is the store's, not the machine's.
    expect(statSync(entry.path!).mode & 0o777).toBe(0o600);

    // The source is replaced, then deleted: the token serves the same bytes.
    writeFileSync(file, "y".repeat(500));
    expect(store.verifyStoredFile(store.get(token)!)).toBe(true);
    rmSync(file);
    const open = store.openStoredFile(store.get(token)!)!;
    expect(open).not.toBeNull();
    const seen = Buffer.alloc(500);
    readSync(open.fd, seen, 0, 500, 0);
    expect(seen.toString()).toBe("x".repeat(500));
    closeSync(open.fd);
    store.close();
  });

  it("a symlink at the source path cannot redirect a retained token", () => {
    const store = new WebAttachmentStore(dbPath(), 60_000, 200, 64);
    const file = fileWith("z".repeat(500), "big.bin");
    const secret = fileWith("PRIVATE-KEY-MATERIAL".padEnd(500, "!"), "secret.bin");
    const token = store.register({ name: "big.bin", path: file });
    rmSync(file);
    symlinkSync(secret, file);
    const entry = store.get(token)!;
    expect(store.verifyStoredFile(entry)).toBe(true);
    expect(readFileSync(entry.path!, "utf-8")).toBe("z".repeat(500));
    expect(readFileSync(entry.path!, "utf-8")).not.toContain("PRIVATE-KEY-MATERIAL");
    store.close();
  });

  // The integrity half stays: the retained copy is the store's, and anything
  // that is not those exact bytes is refused rather than served.
  it("refuses a retained copy that was tampered with, whatever the tamper", () => {
    const store = new WebAttachmentStore(dbPath(), 60_000, 200, 64);
    const token = store.register({ name: "big.bin", path: fileWith("a".repeat(500), "big.bin") });
    const copy = store.get(token)!.path!;

    // Same size, different bytes: the checksum catches it.
    writeFileSync(copy, "b".repeat(500));
    expect(store.verifyStoredFile(store.get(token)!)).toBe(false);
    // Different size.
    writeFileSync(copy, "a".repeat(499));
    expect(store.verifyStoredFile(store.get(token)!)).toBe(false);
    // A symlink where the copy was — O_NOFOLLOW refuses it even with the right
    // bytes on the other end.
    const bait = fileWith("a".repeat(500), "bait.bin");
    rmSync(copy);
    symlinkSync(bait, copy);
    expect(store.verifyStoredFile(store.get(token)!)).toBe(false);
    expect(store.openStoredFile(store.get(token)!)).toBeNull();
    // Gone entirely.
    rmSync(copy);
    expect(store.openStoredFile(store.get(token)!)).toBeNull();
    store.close();
  });

  // The race the finding names: verification and the stream used to be two
  // separate opens of a path, so a file replaced in between was streamed under
  // the verified length. One fd, verified and read.
  it("streams the verified inode, not the path: a replacement after opening is not served", () => {
    const store = new WebAttachmentStore(dbPath(), 60_000, 200, 64);
    const token = store.register({ name: "big.bin", path: fileWith("original".padEnd(500, "."), "big.bin") });
    const entry = store.get(token)!;
    const open = store.openStoredFile(entry)!;
    expect(open.sizeBytes).toBe(500);

    // Between verification and the read the file at that path becomes something
    // else — the exact window the old code streamed through.
    rmSync(entry.path!);
    writeFileSync(entry.path!, "REPLACEMENT".padEnd(500, "!"));

    const seen = Buffer.alloc(500);
    readSync(open.fd, seen, 0, 500, 0);
    expect(seen.toString()).toContain("original");
    expect(seen.toString()).not.toContain("REPLACEMENT");
    closeSync(open.fd);
    store.close();
  });

  it("survives a restart: the retained copy is next to the database, not in the process", () => {
    const db = dbPath();
    const first = new WebAttachmentStore(db, 60_000, 200, 64);
    const file = fileWith("recording bytes".padEnd(500, "."), "recording.mp4");
    const token = first.register({ name: "recording.mp4", path: file });
    first.close();
    rmSync(file);

    const second = new WebAttachmentStore(db, 60_000, 200, 64);
    const entry = second.get(token)!;
    expect(entry.retained).toBe(true);
    expect(second.verifyStoredFile(entry)).toBe(true);
    expect(readFileSync(entry.path!, "utf-8")).toContain("recording bytes");
    second.close();
  });

  // Retention is the TOKEN's: the copy must not outlive the row, or the spool
  // grows without bound.
  it("deletes the retained copy when the token expires", async () => {
    const store = new WebAttachmentStore(dbPath(), 20, 200, 64);
    const token = store.register({ name: "big.bin", path: fileWith("q".repeat(500), "big.bin") });
    const copy = store.get(token)!.path!;
    expect(existsSync(copy)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    // The sweep takes the row AND the copy it owned: a spool that outlives its
    // tokens is a directory that grows for ever.
    expect(store.size()).toBe(0);
    expect(store.get(token)).toBeNull();
    expect(existsSync(copy)).toBe(false);
    store.close();
  });

  it("deletes the retained copy when the entry bound evicts the row", () => {
    const store = new WebAttachmentStore(dbPath(), 60_000, 2, 64);
    const first = store.register({ name: "a.bin", path: fileWith("1".repeat(500), "a.bin") });
    const firstCopy = store.get(first)!.path!;
    store.register({ name: "b.bin", path: fileWith("2".repeat(500), "b.bin") });
    store.register({ name: "c.bin", path: fileWith("3".repeat(500), "c.bin") });
    expect(store.get(first)).toBeNull();
    expect(existsSync(firstCopy)).toBe(false);
    store.close();
  });

  it("sweeps a copy whose row is gone (a crash between the copy and the insert)", () => {
    const db = dbPath();
    const first = new WebAttachmentStore(db, 60_000, 200, 64);
    const token = first.register({ name: "big.bin", path: fileWith("k".repeat(500), "big.bin") });
    const copy = first.get(token)!.path!;
    const orphan = join(dirname(copy), "orphan-token");
    writeFileSync(orphan, "left behind");
    first.close();

    const second = new WebAttachmentStore(db, 60_000, 200, 64);
    expect(existsSync(orphan)).toBe(false);
    // …and the copy that DOES have a row is untouched.
    expect(second.verifyStoredFile(second.get(token)!)).toBe(true);
    second.close();
  });

  // When the copy cannot be made, the token keeps the checksummed reference it
  // had before: a 2 GB recording with no spool space is still deliverable, and
  // the store never deletes a file it did not write.
  it("falls back to a checksummed reference when the private copy cannot be made", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-attach-nospool-"));
    dirs.push(dir);
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "not a directory");
    const store = new WebAttachmentStore(dbPath(), 60_000, 200, 64, join(blocker, "blobs"));
    const file = fileWith("w".repeat(500), "recording.mp4");
    const token = store.register({ name: "recording.mp4", path: file });
    const entry = store.get(token)!;
    expect(entry.retained).toBeUndefined();
    expect(entry.path).toBe(realpathSync(file));
    expect(store.verifyStoredFile(entry)).toBe(true);
    // And the reference is still only good for the registered bytes.
    writeFileSync(file, "v".repeat(500));
    expect(store.verifyStoredFile(store.get(token)!)).toBe(false);
    // The caller's file is never deleted when ITS row goes away: the store only
    // ever removes copies it wrote itself.
    const bounded = new WebAttachmentStore(dbPath(), 60_000, 1, 64, join(blocker, "blobs"));
    const kept = fileWith("u".repeat(500), "keepme.mp4");
    const doomed = bounded.register({ name: "keepme.mp4", path: kept });
    expect(bounded.get(doomed)!.path).toBe(realpathSync(kept));
    bounded.register({ name: "next.mp4", path: fileWith("t".repeat(500), "next.mp4") });
    expect(bounded.get(doomed)).toBeNull();
    expect(existsSync(kept)).toBe(true);
    expect(readFileSync(kept, "utf-8")).toBe("u".repeat(500));
    bounded.close();
    expect(existsSync(file)).toBe(true);
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
