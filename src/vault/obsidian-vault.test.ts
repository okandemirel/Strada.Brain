import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObsidianVault, VaultQueryError, redactPathsInMessage } from './obsidian-vault.js';
import type { EmbeddingProvider, VectorStore } from './embedding-adapter.js';
import type { IVault } from './vault.interface.js';

function fakeEmbedding(overrides?: Partial<EmbeddingProvider>): EmbeddingProvider {
  return {
    model: 'fake-embed',
    dim: 4,
    embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
    ...overrides,
  };
}

function fakeVectorStore(): VectorStore {
  let next = 1;
  const items = new Map<number, { payload: unknown }>();
  return {
    add: (_v, payload) => { const id = next++; items.set(id, { payload }); return id; },
    remove: (id) => { items.delete(id); },
    search: (_v, k) => [...items.entries()].slice(0, k).map(([id, e]) => ({ id, score: 1, payload: e.payload })),
    clear: () => items.clear(),
  };
}

// Unreachable port → healthCheck/putNote fail fast and exercise FS fallbacks.
const OFFLINE_OBSIDIAN = { apiUrl: 'http://127.0.0.1:1', apiKey: 'test' };

describe('ObsidianVault', () => {
  const tempDirs: string[] = [];
  const vaults: IVault[] = [];

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'strada-obsidian-vault-'));
    tempDirs.push(root);
    return root;
  }

  function makeVault(root: string, embedding: EmbeddingProvider = fakeEmbedding()): ObsidianVault {
    const vault = new ObsidianVault({
      id: 'test-obsidian',
      rootPath: root,
      embedding,
      vectorStore: fakeVectorStore(),
      obsidian: OFFLINE_OBSIDIAN,
    });
    vaults.push(vault);
    return vault;
  }

  afterEach(async () => {
    // Dispose BEFORE rmSync: better-sqlite3 keeps the db file open.
    for (const v of vaults.splice(0)) await v.dispose();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent sync() calls through the write lock', async () => {
    const root = makeRoot();
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), '# original');

    let active = 0;
    let overlapped = false;
    const vault = makeVault(root, fakeEmbedding({
      embed: async (texts) => {
        active++;
        if (active > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, 25));
        active--;
        return texts.map(() => new Float32Array([1, 0, 0, 0]));
      },
    }));
    await vault.init();

    writeFileSync(join(root, 'notes', 'a.md'), '# modified content');
    const [r1, r2] = await Promise.all([vault.sync(), vault.sync()]);

    expect(overlapped).toBe(false);
    // Exactly one sync indexes the change; the other short-circuits on the
    // now-unchanged hash. Both seeing it (=2) or neither would mean the lock
    // no longer serializes the passes.
    expect(r1.changed + r2.changed).toBe(1);
  });

  it('falls back to a filesystem write when the Obsidian API is unreachable', async () => {
    const root = makeRoot();
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), '# original');
    const vault = makeVault(root);
    await vault.init();

    await vault.writeFile('notes/n.md', '# note');
    expect(readFileSync(join(root, 'notes', 'n.md'), 'utf8')).toBe('# note');

    await expect(vault.writeFile('../evil.md', 'x')).rejects.toThrow(/escapes vault root/);
    expect(existsSync(join(root, '..', 'evil.md'))).toBe(false);
  });

  it('keeps the old canvas intact and cleans up the tmp file when rename fails', async () => {
    const root = makeRoot();
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), '# original');
    const vault = makeVault(root);
    await vault.init();

    const canvasPath = join(root, '.strada', 'vault', 'graph.canvas');
    expect(existsSync(canvasPath)).toBe(true);

    // Force fsp.rename(tmp, finalPath) to fail: replace the canvas file with
    // a non-empty directory at the exact same path (rename file→dir = EISDIR/
    // ENOTEMPTY on POSIX).
    rmSync(canvasPath);
    mkdirSync(canvasPath);
    writeFileSync(join(canvasPath, 'occupied.txt'), 'x');

    writeFileSync(join(root, 'notes', 'a.md'), '# modified content');
    const r = await vault.sync();

    expect(r.changed).toBe(1);
    expect(r.canvas?.ok).toBe(false);
    // Old path untouched, tmp cleaned up.
    expect(statSync(canvasPath).isDirectory()).toBe(true);
    expect(existsSync(join(canvasPath, 'occupied.txt'))).toBe(true);
    expect(existsSync(`${canvasPath}.tmp`)).toBe(false);
    // SecH1: the returned error never leaks the vault's absolute path.
    expect(r.canvas?.error).toBeTruthy();
    expect(r.canvas?.error).not.toContain(root);
    expect(r.canvas?.error).not.toContain(realpathSync(root));
  });

  it('throws VaultQueryError for a whitespace-only query', async () => {
    const root = makeRoot();
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), '# original');
    const vault = makeVault(root);
    await vault.init();

    await expect(vault.query({ text: '   ' })).rejects.toThrowError(VaultQueryError);
  });

  describe('redactPathsInMessage', () => {
    it('replaces the vault root path with <vault>', () => {
      expect(redactPathsInMessage('rename failed at /lex/vault/graph.canvas', '/lex/vault'))
        .toBe('rename failed at <vault>/graph.canvas');
    });

    it('replaces a differing realpath root with <vault>', () => {
      expect(redactPathsInMessage('failed at /real/vault/x.md', '/lex/vault', '/real/vault'))
        .toBe('failed at <vault>/x.md');
    });

    it('replaces the home directory with <home>', () => {
      expect(redactPathsInMessage(`open ${homedir()}/secret.txt failed`, '/nonmatching-root'))
        .toBe('open <home>/secret.txt failed');
    });

    it('returns the input unchanged when nothing matches', () => {
      expect(redactPathsInMessage('nothing sensitive here', '/some/root')).toBe('nothing sensitive here');
    });

    it('handles the empty string', () => {
      expect(redactPathsInMessage('', '/some/root')).toBe('');
    });
  });
});
