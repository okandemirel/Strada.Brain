import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultWatcher } from '../../src/vault/watcher.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'watcher-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('VaultWatcher', () => {
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
