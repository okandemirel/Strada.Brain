import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
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
