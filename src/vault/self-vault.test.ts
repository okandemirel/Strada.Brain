import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SelfVault } from './self-vault.js';
import { createFakeEmbedding, createFakeVectorStore, createTempDirTracker } from '../test-helpers.js';

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));

vi.mock('../utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: logWarn, error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: logWarn, error: vi.fn(), debug: vi.fn() }),
}));

describe('SelfVault exclusions on the reindex path (MEM-19)', () => {
  const tmp = createTempDirTracker('strada-self-vault-');
  const vaults: SelfVault[] = [];

  afterEach(async () => {
    for (const v of vaults.splice(0)) await v.dispose();
    tmp.cleanup();
  });

  function write(root: string, rel: string, body: string): void {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }

  async function makeVault(root: string): Promise<SelfVault> {
    const vault = new SelfVault({
      id: 'self',
      rootPath: root,
      embedding: createFakeEmbedding(),
      vectorStore: createFakeVectorStore(),
    });
    vaults.push(vault);
    await vault.init();
    return vault;
  }

  it('does not index a path that discovery excludes when a watcher or write-hook reports it', async () => {
    const root = tmp.makeDir();
    write(root, 'src/app.ts', 'export const app = 1;\n');
    const vault = await makeVault(root);
    expect(vault.listFiles().map((f) => f.path)).toEqual(['src/app.ts']);

    // Files that appear while the daemon runs, reported one by one the way
    // the per-root watchers and the write-hook do.
    const excluded = [
      'tests/fixtures/secrets/api-token.ts',
      'tests/tmp/scratch.ts',
      'src/dist/bundle.ts',
      'src/coverage/report.json',
      'scripts/release.ts',
    ];
    for (const rel of excluded) {
      write(root, rel, 'export const leaked = "value";\n');
      expect(await vault.reindexFile(rel)).toBe(false);
    }

    write(root, 'src/feature.ts', 'export const feature = 2;\n');
    expect(await vault.reindexFile('src/feature.ts')).toBe(true);

    expect(vault.listFiles().map((f) => f.path).sort()).toEqual(['src/app.ts', 'src/feature.ts']);
  });
});

describe('SelfVault initial index running in the background', () => {
  const tmp = createTempDirTracker('strada-self-vault-bg-');

  afterEach(() => {
    vi.restoreAllMocks();
    logWarn.mockClear();
    tmp.cleanup();
  });

  function makeTree(fileCount: number): string {
    const root = tmp.makeDir();
    mkdirSync(join(root, 'src'), { recursive: true });
    for (let i = 0; i < fileCount; i++) writeFileSync(join(root, 'src', `f${i}.ts`), `export const f${i} = ${i};\n`);
    return root;
  }

  function newVault(root: string): SelfVault {
    return new SelfVault({
      id: 'self',
      rootPath: root,
      embedding: createFakeEmbedding(),
      vectorStore: createFakeVectorStore(),
    });
  }

  it('dispose during the initial index stops it cleanly and starts no watcher', async () => {
    const vault = newVault(makeTree(5));
    const reindex = vault.reindexFile.bind(vault);
    let entered!: () => void;
    const firstFile = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reindexSpy = vi.spyOn(vault, 'reindexFile').mockImplementation(async (rel) => {
      entered();
      await gate;
      return reindex(rel);
    });

    const init = vault.init();
    await firstFile;
    const disposed = vault.dispose();
    release();

    await expect(disposed).resolves.toBeUndefined();
    await expect(init).resolves.toBeUndefined();
    // The walk stopped at the next file instead of running the rest of the
    // tree against a closed store.
    expect(reindexSpy).toHaveBeenCalledTimes(1);
    expect(logWarn).not.toHaveBeenCalled();

    // A startWatch that arrives after dispose (the background task finishing)
    // must not leave watchers nothing will stop.
    await vault.startWatch(10);
    expect((vault as unknown as { watcher: unknown }).watcher).toBeNull();
  });

  it('a second init while the first is running joins it instead of walking again', async () => {
    const vault = newVault(makeTree(3));
    const reindexSpy = vi.spyOn(vault, 'reindexFile');
    await Promise.all([vault.init(), vault.init()]);
    expect(reindexSpy).toHaveBeenCalledTimes(3);
    expect(vault.listFiles()).toHaveLength(3);
    await vault.dispose();
  });
});

/** vault-intelligence#4, SelfVault's own walk. */
describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'SelfVault: a directory its walk cannot read is not a deleted directory',
  () => {
    const tmp = createTempDirTracker('strada-self-vault-unreadable-');
    const vaults: SelfVault[] = [];
    const locked: string[] = [];

    afterEach(async () => {
      for (const p of locked.splice(0)) chmodSync(p, 0o755);
      for (const v of vaults.splice(0)) await v.dispose();
      tmp.cleanup();
    });

    it('a sync does not prune the files under a directory it could not read', async () => {
      const root = tmp.makeDir();
      mkdirSync(join(root, 'src', 'core'), { recursive: true });
      writeFileSync(join(root, 'src', 'core', 'engine.ts'), 'export const engine = 1;\n');
      const vault = new SelfVault({
        id: 'self',
        rootPath: root,
        embedding: createFakeEmbedding(),
        vectorStore: createFakeVectorStore(),
      });
      vaults.push(vault);
      await vault.init();
      expect(vault.listFiles().map((f) => f.path)).toEqual(['src/core/engine.ts']);

      chmodSync(join(root, 'src', 'core'), 0o000);
      locked.push(join(root, 'src', 'core'));
      await vault.sync();
      chmodSync(join(root, 'src', 'core'), 0o755);

      expect(vault.listFiles().map((f) => f.path)).toEqual(['src/core/engine.ts']);
    });
  },
);

/** vault-intelligence#6, SelfVault's sync override. */
describe('SelfVault: a reindex that failed is not an unchanged file', () => {
  const tmp = createTempDirTracker('strada-self-vault-failed-');
  const vaults: SelfVault[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const v of vaults.splice(0)) await v.dispose();
    tmp.cleanup();
  });

  it('sync counts a file whose SQL write failed as failed, not as unchanged', async () => {
    const root = tmp.makeDir();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.ts'), 'export const app = 1;\n');
    const vault = new SelfVault({
      id: 'self',
      rootPath: root,
      embedding: createFakeEmbedding(),
      vectorStore: createFakeVectorStore(),
    });
    vaults.push(vault);
    await vault.init();
    writeFileSync(join(root, 'src', 'app.ts'), 'export const app = 2;\n');
    const store = (vault as unknown as { store: { runReindexTxn: (...a: unknown[]) => unknown } }).store;
    vi.spyOn(store, 'runReindexTxn').mockReturnValue({ ok: false, error: 'SQLITE_FULL: database or disk is full' });

    expect(await vault.sync()).toMatchObject({ changed: 0, failed: 1 });
  });
});
