import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnityProjectVault } from './unity-project-vault.js';
import { createFakeEmbedding, createFakeVectorStore, createTempDirTracker } from '../test-helpers.js';
import type { EmbeddingProvider } from './embedding-adapter.js';
import type { IVault } from './vault.interface.js';

describe('UnityProjectVault', () => {
  const tmp = createTempDirTracker('strada-unity-vault-');
  const vaults: IVault[] = [];

  function makeVault(root: string, embedding: EmbeddingProvider = createFakeEmbedding()): UnityProjectVault {
    const vault = new UnityProjectVault({
      id: 'test-unity',
      rootPath: root,
      embedding,
      vectorStore: createFakeVectorStore(),
    });
    vaults.push(vault);
    return vault;
  }

  afterEach(async () => {
    // Dispose BEFORE cleanup: better-sqlite3 keeps the db file open.
    for (const v of vaults.splice(0)) await v.dispose();
    tmp.cleanup();
  });

  it('indexes markdown files on init', async () => {
    const root = tmp.makeDir();
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
    const root = tmp.makeDir();
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
    const root = tmp.makeDir();
    const outside = tmp.makeDir('strada-unity-outside-');
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
    const root = tmp.makeDir();
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
    const root = tmp.makeDir();
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
    const root = tmp.makeDir();
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), '# alpha note');
    const vault = makeVault(root, createFakeEmbedding({
      embed: async () => { throw new Error('provider down'); },
    }));

    await expect(vault.init()).resolves.toBeUndefined();
    expect(vault.listFiles().map((f) => f.path)).toContain('notes/a.md');
  });
});
