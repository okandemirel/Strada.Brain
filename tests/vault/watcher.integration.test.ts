import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultWatcher } from '../../src/vault/watcher.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'watcher-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('VaultWatcher', () => {
  it('sees a file written the instant start() resolves', async () => {
    // start() must not resolve until the backend is actually armed. Chokidar's
    // 'ready' only means the initial scan finished: measured on macOS with
    // native FSEvents, writing immediately after 'ready' produced no event at
    // all for 10 of 20 files. A settle window closes that gap.
    //
    // This is the failure the default-to-native-events change introduced, and
    // it is invisible in production — the file the user just wrote simply never
    // gets indexed, with nothing in the logs to say so.
    //
    // Two details are required to reproduce, and both are easy to lose:
    //  - the write lands in a SUBDIRECTORY (the root is armed first; the lag
    //    is in registering the recursive watches beneath it), and
    //  - each attempt uses a FRESH directory (macOS keeps an FSEvents stream
    //    warm per path, so re-watching the same directory hides the race).
    //
    // The race is probabilistic — roughly one attempt in five misses without
    // the settle — so the loop trades ~12 s of runtime for enough attempts to
    // make detection reliable. A single attempt would pass most of the time.
    for (let attempt = 0; attempt < 10; attempt++) {
      const root = mkdtempSync(join(tmpdir(), 'watcher-fresh-'));
      try {
        mkdirSync(join(root, 'Assets', 'Scripts'), { recursive: true });
        writeFileSync(join(root, 'Assets', 'Scripts', 'Existing.cs'), 'x');

        const seen: string[] = [];
        const w = new VaultWatcher({
          root, debounceMs: 50,
          onBatch: async (p) => { seen.push(...p); },
        });
        await w.start();
        writeFileSync(join(root, 'Assets', 'Scripts', 'Fresh.cs'), 'namespace Game { class Fresh {} }');
        await new Promise((r) => setTimeout(r, 1200));
        await w.stop();
        expect(seen, `attempt ${attempt}`).toContain('Assets/Scripts/Fresh.cs');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('debounces multiple writes into one batch', async () => {
    const batches: string[][] = [];
    const w = new VaultWatcher({
      root: dir, debounceMs: 200,
      onBatch: async (paths) => { batches.push(paths); },
    });
    await w.start();
    writeFileSync(join(dir, 'a.cs'), 'x');
    writeFileSync(join(dir, 'b.cs'), 'x');
    await new Promise((r) => setTimeout(r, 1500));
    await w.stop();
    expect(batches.length).toBe(1);
    expect(batches[0].sort()).toEqual(['a.cs', 'b.cs']);
  });

  it('ignores Library/', async () => {
    const seen: string[] = [];
    const w = new VaultWatcher({
      root: dir, debounceMs: 100,
      onBatch: async (p) => { seen.push(...p); },
    });
    await w.start();
    writeFileSync(join(dir, 'real.cs'), 'x');
    mkdirSync(join(dir, 'Library'));
    writeFileSync(join(dir, 'Library/junk.cs'), 'x');
    await new Promise((r) => setTimeout(r, 400));
    await w.stop();
    expect(seen).toContain('real.cs');
    expect(seen.every((p) => !p.includes('Library'))).toBe(true);
  });
});
