import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultWatcher } from "./watcher.js";

// Regression harness for the 2026-08-26 fd-exhaustion incident: on macOS
// chokidar registers one fs.watch(file) per discovered file, and each of those
// pins an FSEvents fd for the process lifetime. A Unity project vault rooted
// at the project directory therefore watched every Recordings frame and .asset
// artifact (~11K fds within minutes of boot; spawn started failing with EBADF).
// The watcher must keep non-indexable files out of chokidar's watch set.

const root = mkdtempSync(join(tmpdir(), "vault-watch-fd-"));
mkdirSync(join(root, "src"), { recursive: true });
mkdirSync(join(root, "Recordings"), { recursive: true });
writeFileSync(join(root, "src", "index.ts"), "export const a = 1;\n");
writeFileSync(join(root, "Recordings", "frame_0001.png"), "png-bytes");
writeFileSync(join(root, "Recordings", "frame_0002.png"), "png-bytes");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

type WatchedLike = { getWatched(): Record<string, string[]> };

describe("VaultWatcher watch scope", () => {
  it("watches indexable files only — artifacts like frame PNGs stay unwatched", async () => {
    const watcher = new VaultWatcher({
      root,
      debounceMs: 10,
      onBatch: () => {},
    });
    await watcher.start();
    try {
      // 'ready' fired inside start(); the watch set is populated by now.
      const internal = watcher as unknown as { watcher: WatchedLike | null };
      const watched = internal.watcher?.getWatched() ?? {};

      const files = Object.entries(watched).flatMap(([dir, names]) =>
        names.map((n) => `${dir}/${n}`),
      );

      expect(files.some((f) => f.endsWith("src/index.ts"))).toBe(true);
      expect(files.some((f) => f.endsWith(".png"))).toBe(false);
      // The Recordings *directory* stays watched (one fd) so a newly written
      // source file inside it would still be discovered — but none of its
      // artifact contents may enter the watch set.
      const recordingsFiles = Object.entries(watched)
        .filter(([d]) => d.endsWith("Recordings"))
        .flatMap(([, names]) => names);
      expect(recordingsFiles).toEqual([]);
    } finally {
      await watcher.stop();
    }
  });
});
