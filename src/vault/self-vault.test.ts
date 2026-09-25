import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SelfVault } from './self-vault.js';
import { createFakeEmbedding, createFakeVectorStore, createTempDirTracker } from '../test-helpers.js';

vi.mock('../utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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
