import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnityProjectVault } from './unity-project-vault.js';
import { createFakeEmbedding, createFakeVectorStore, createTempDirTracker } from '../test-helpers.js';

const warnings = vi.hoisted(() => [] as string[]);
vi.mock('../utils/logger.js', () => {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: (msg: string) => { warnings.push(msg); },
  };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

describe('UnityProjectVault canvas regeneration (MEM-15)', () => {
  const tmp = createTempDirTracker('strada-canvas-');
  const vaults: UnityProjectVault[] = [];

  afterEach(async () => {
    for (const v of vaults.splice(0)) await v.dispose();
    tmp.cleanup();
    warnings.length = 0;
  });

  it('concurrent regenerations each publish a whole canvas and leave no temp file behind', async () => {
    const root = tmp.makeDir();
    mkdirSync(join(root, 'notes'));
    for (let i = 0; i < 60; i++) {
      writeFileSync(join(root, 'notes', `n${i}.md`), `# Note ${i}\n\nSee [[n${(i + 1) % 60}]] and [[n${(i + 7) % 60}]].\n`);
    }
    const vault = new UnityProjectVault({
      id: 'canvas-race',
      rootPath: root,
      embedding: createFakeEmbedding(),
      vectorStore: createFakeVectorStore(),
    });
    vaults.push(vault);
    await vault.init();
    warnings.length = 0;

    // Two watchers draining at once plus a sync: three regenerations in flight.
    await Promise.all([vault.regenerateCanvas(), vault.regenerateCanvas(), vault.regenerateCanvas()]);

    expect(warnings.filter((w) => w.includes('canvas regen failed'))).toEqual([]);
    const vaultDir = join(root, '.strada', 'vault');
    expect(readdirSync(vaultDir).filter((name) => name.includes('.tmp'))).toEqual([]);
    const canvas = JSON.parse(readFileSync(join(vaultDir, 'graph.canvas'), 'utf8')) as { nodes: unknown[] };
    expect(canvas.nodes.length).toBeGreaterThan(0);
  });
});
