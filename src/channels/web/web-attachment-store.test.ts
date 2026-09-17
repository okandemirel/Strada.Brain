/**
 * Plan 2.8 (the durable form of 0-A.4): an attachment link must still resolve
 * after the daemon restarts. The records used to live in a Map, so every
 * `/attachments/<token>` URL in the history — including the ones the reconnect
 * replay re-sends — answered 404 the moment the process was replaced.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
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
    const fileToken = first.register({ name: "HOW_TO_RUN.md", path: "/tmp/HOW_TO_RUN.md" });
    first.close();

    // A new process — the link in the chat history must still work.
    const second = new WebAttachmentStore(path);
    expect(second.get(imageToken)).toMatchObject({ name: "frame.png", mimeType: "image/png", chatId: "chat-1" });
    expect(second.get(imageToken)!.data).toEqual(bytes);
    expect(second.get(fileToken)).toMatchObject({ name: "HOW_TO_RUN.md", path: "/tmp/HOW_TO_RUN.md" });
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
