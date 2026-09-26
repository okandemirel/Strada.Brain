/**
 * The retained-copy symlink defence on a platform without O_NOFOLLOW.
 *
 * Windows 2026-09-26: `fs.constants.O_NOFOLLOW` is undefined there, so
 * `O_RDONLY | O_NOFOLLOW` was plain O_RDONLY and a symlink put where a retained
 * copy was opened its target. A target with the registered bytes passed every
 * check and was served. Linux CI would never see it, so this file takes the
 * flag away and runs the same refusal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { O_NOFOLLOW: _absentOnWindows, ...constants } = actual.constants;
  return { ...actual, constants, default: { ...actual, constants } };
});

const { WebAttachmentStore } = await import("./web-attachment-store.js");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "web-attach-nofollow-"));
  dirs.push(dir);
  return dir;
}

describe("WebAttachmentStore without O_NOFOLLOW (Windows)", () => {
  it("still refuses a symlink where a retained copy was, even to the registered bytes", () => {
    const dir = tempDir();
    const store = new WebAttachmentStore(join(dir, "web-attachments.db"), 60_000, 200, 64);
    try {
      const source = join(dir, "big.bin");
      writeFileSync(source, "a".repeat(500));
      const token = store.register({ name: "big.bin", path: source });
      const copy = store.get(token)!.path!;
      expect(store.verifyStoredFile(store.get(token)!)).toBe(true);

      const bait = join(dir, "bait.bin");
      writeFileSync(bait, "a".repeat(500));
      rmSync(copy);
      symlinkSync(bait, copy);
      expect(store.verifyStoredFile(store.get(token)!)).toBe(false);
      expect(store.openStoredFile(store.get(token)!)).toBeNull();
    } finally {
      store.close();
    }
  });
});
