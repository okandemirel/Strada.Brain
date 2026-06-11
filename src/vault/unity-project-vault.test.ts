import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UnityProjectVault } from './unity-project-vault.js';
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

describe('UnityProjectVault', () => {
  const tempDirs: string[] = [];
  const vaults: IVault[] = [];

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'strada-unity-vault-'));
    tempDirs.push(root);
    return root;
  }

  function makeVault(root: string, embedding: EmbeddingProvider = fakeEmbedding()): UnityProjectVault {
    const vault = new UnityProjectVault({
      id: 'test-unity',
      rootPath: root,
      embedding,
      vectorStore: fakeVectorStore(),
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

  it('indexes markdown files on init', async () => {
    const root = makeRoot();
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), '# alpha note\n\nbody text');
    const vault = makeVault(root);

    await vault.init();

    const files = vault.listFiles();
    expect(files.map((f) => f.path)).toContain('notes/a.md');
    expect(files.find((f) => f.path === 'notes/a.md')?.blobHash).not.toBe('');
    expect((await vault.stats()).fileCount).toBe(1);
  });

  it('short-circuits reindexFile on unchanged content hash (Fix C1)', async () => {
    const root = makeRoot();
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), '# alpha note');
    const vault = makeVault(root);
    await vault.init();

    expect(await vault.reindexFile('notes/a.md')).toBe(false);

    writeFileSync(join(root, 'notes', 'a.md'), '# alpha note CHANGED');
    expect(await vault.reindexFile('notes/a.md')).toBe(true);

    const { changed } = await vault.sync();
    expect(changed).toBe(0);
  });

  it('confines reads to the vault root via the public API', async () => {
    const root = makeRoot();
    const outside = mkdtempSync(join(tmpdir(), 'strada-unity-outside-'));
    tempDirs.push(outside);
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), '# alpha note');
    const outsideFile = join(outside, 'outside.md');
    writeFileSync(outsideFile, '# outside');
    symlinkSync(outsideFile, join(root, 'link.md'));
    const vault = makeVault(root);
    await vault.init();

    await expect(vault.readFile('../outside.md')).rejects.toThrow(/escapes vault root/);
    await expect(vault.readFile('/etc/hosts')).rejects.toThrow(/escapes vault root/);
    await expect(vault.readFile('link.md')).rejects.toThrow(/uses a symlink/);
    expect(await vault.readFile('notes/a.md')).toBe('# alpha note');
  });

  it('confines writes to the vault root', async () => {
    const root = makeRoot();
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), '# alpha note');
    const vault = makeVault(root);
    await vault.init();

    await vault.writeFile('notes/new.md', '# hi');
    expect(readFileSync(join(root, 'notes', 'new.md'), 'utf8')).toBe('# hi');

    await expect(vault.writeFile('../evil.md', 'x')).rejects.toThrow(/escapes vault root/);
    await expect(vault.writeFile('secrets.json', '{}')).rejects.toThrow(/not allowed/);
    expect(existsSync(join(root, '..', 'evil.md'))).toBe(false);
  });

  it('prunes deleted files on sync', async () => {
    const root = makeRoot();
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), '# alpha');
    writeFileSync(join(root, 'notes', 'b.md'), '# beta');
    const vault = makeVault(root);
    await vault.init();
    expect(vault.listFiles()).toHaveLength(2);

    rmSync(join(root, 'notes', 'b.md'));
    const { changed } = await vault.sync();

    expect(changed).toBe(1);
    expect(vault.listFiles().map((f) => f.path)).not.toContain('notes/b.md');
  });

  it('keeps FTS indexing when the embedding provider fails (best-effort)', async () => {
    const root = makeRoot();
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), '# alpha note');
    const vault = makeVault(root, fakeEmbedding({
      embed: async () => { throw new Error('provider down'); },
    }));

    await expect(vault.init()).resolves.toBeUndefined();
    expect(vault.listFiles().map((f) => f.path)).toContain('notes/a.md');
  });
});
