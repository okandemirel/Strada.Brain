import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultWatcher } from '../../src/vault/watcher.js';

let vaultDir: string;
let elsewhereDir: string;

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), 'vault-watcher-symlink-'));
  elsewhereDir = mkdtempSync(join(tmpdir(), 'vault-elsewhere-'));
});
afterEach(() => {
  rmSync(vaultDir, { recursive: true, force: true });
  rmSync(elsewhereDir, { recursive: true, force: true });
});

describe('VaultWatcher symlink-directory containment', () => {
  it('skips files under a symlinked directory inside the vault', async () => {
    // Place a real markdown file outside the vault, then symlink the
    // containing directory into the vault. Without the ancestor check, the
    // watcher would surface that file as a vault-relative path.
    writeFileSync(join(elsewhereDir, 'leak.md'), '# leak');
    // Create the symlink BEFORE starting the watcher so chokidar's initial
    // scan includes the symlinked directory.
    symlinkSync(elsewhereDir, join(vaultDir, 'secret'), 'dir');

    const seen: string[] = [];
    const w = new VaultWatcher({
      root: vaultDir,
      debounceMs: 100,
      onBatch: async (paths) => {
        seen.push(...paths);
      },
    });
    await w.start();
    // Trigger a change inside the symlink target so an event fires.
    writeFileSync(join(elsewhereDir, 'leak.md'), '# leak v2');
    // Also write a legitimate file so we know the watcher is alive.
    writeFileSync(join(vaultDir, 'ok.md'), '# ok');
    await new Promise((r) => setTimeout(r, 600));
    await w.stop();

    expect(seen).toContain('ok.md');
    // Path under the symlinked directory must not appear in any batch.
    expect(seen.every((p) => !p.startsWith('secret/'))).toBe(true);
  });
});
