import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, cpSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnityProjectVault } from '../../src/vault/unity-project-vault.js';
import { VaultRegistry } from '../../src/vault/vault-registry.js';
import {
  FileReadTool,
  getVaultFileReadStats,
  resetVaultFileReadStats,
} from '../../src/agents/tools/file-read.js';
import type { EmbeddingProvider, VectorStore } from '../../src/vault/embedding-adapter.js';
import type { ToolContext } from '../../src/agents/tools/tool.interface.js';

// ── Zero-vector embedding + in-memory HNSW stub (no network, no servers) ──
class ZeroEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'zero-stub';
  readonly dim = 4;
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(4));
  }
}

class InMemVectorStore implements VectorStore {
  private next = 1;
  readonly items = new Map<number, { v: Float32Array; payload: unknown }>();
  add(v: Float32Array, payload: unknown): number {
    const id = this.next++;
    this.items.set(id, { v, payload });
    return id;
  }
  remove(id: number): void {
    this.items.delete(id);
  }
  search(_v: Float32Array, k: number): Array<{ id: number; score: number; payload: unknown }> {
    return [...this.items.entries()].slice(0, k).map(([id, rec]) => ({
      id,
      score: 0.5,
      payload: rec.payload,
    }));
  }
}

let fixtureDir: string;
let outsideDir: string;
let vault: UnityProjectVault;
let registry: VaultRegistry;
let tool: FileReadTool;
let ctx: ToolContext;

beforeEach(async () => {
  fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), 'telemetry-')));
  cpSync('tests/fixtures/ts-mini', fixtureDir, { recursive: true });
  outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'telemetry-out-')));
  writeFileSync(
    join(outsideDir, 'outside.ts'),
    'const x = 1;\nconst y = 2;\nconst z = 3;\n',
  );

  vault = new UnityProjectVault({
    id: 'ts-mini-tel',
    rootPath: fixtureDir,
    embedding: new ZeroEmbeddingProvider(),
    vectorStore: new InMemVectorStore(),
  });
  await vault.init();

  registry = new VaultRegistry();
  registry.register(vault);

  tool = new FileReadTool();
  ctx = {
    projectPath: fixtureDir,
    workingDirectory: fixtureDir,
    readOnly: false,
    vaultRegistry: registry,
  };

  resetVaultFileReadStats();
});

afterEach(async () => {
  await registry.disposeAll();
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe('getVaultFileReadStats telemetry', () => {
  it('resetVaultFileReadStats zeros every field', async () => {
    // Cause at least one miss to move a counter off zero.
    const outsideCtx: ToolContext = {
      projectPath: outsideDir,
      workingDirectory: outsideDir,
      readOnly: false,
      vaultRegistry: registry,
    };
    await tool.execute({ path: 'outside.ts', offset: 1, limit: 1 }, outsideCtx);

    const before = getVaultFileReadStats();
    expect(before.misses).toBeGreaterThan(0);

    resetVaultFileReadStats();

    const after = getVaultFileReadStats();
    expect(after).toEqual({ hits: 0, misses: 0, stale: 0 });
  });

  it('counts hits once per successful vault-first read', async () => {
    // Prime the vault with a single cold read (may be a miss the first time).
    await tool.execute({ path: 'src/a.ts', offset: 1, limit: 5 }, ctx);
    resetVaultFileReadStats();

    const N = 3;
    for (let i = 0; i < N; i++) {
      const r = await tool.execute({ path: 'src/a.ts', offset: 1, limit: 5 }, ctx);
      expect(r.isError).toBeUndefined();
    }

    const stats = getVaultFileReadStats();
    expect(stats.hits).toBe(N);
    expect(stats.misses).toBe(0);
    expect(stats.stale).toBe(0);
  });

  it('counts misses once per disk-fallback range read when a registry is attached', async () => {
    // Force misses by pointing at paths no vault owns.
    const outsideCtx: ToolContext = {
      projectPath: outsideDir,
      workingDirectory: outsideDir,
      readOnly: false,
      vaultRegistry: registry,
    };

    const M = 4;
    for (let i = 0; i < M; i++) {
      const r = await tool.execute({ path: 'outside.ts', offset: 1, limit: 1 }, outsideCtx);
      expect(r.isError).toBeUndefined();
    }

    const stats = getVaultFileReadStats();
    expect(stats.misses).toBe(M);
    expect(stats.hits).toBe(0);
    expect(stats.stale).toBe(0);
  });

  it('counts stale reads once per mtime/size drift detection', async () => {
    const abs = join(fixtureDir, 'src/a.ts');
    const K = 3;

    for (let i = 0; i < K; i++) {
      // Warm vault first so indexed state exists.
      await tool.execute({ path: 'src/a.ts', offset: 1, limit: 5 }, ctx);

      // Now mutate the file — next range read detects staleness.
      writeFileSync(
        abs,
        `// iteration-${i}\nexport class Alpha {\n  greet(): string { return 'hi'; }\n  extra${i}(): number { return ${i}; }\n}\nexport function topLevel(): void {}\n`,
      );

      resetVaultFileReadStats();

      const r = await tool.execute({ path: 'src/a.ts', offset: 1, limit: 5 }, ctx);
      expect(r.isError).toBeUndefined();

      const stats = getVaultFileReadStats();
      expect(stats.stale).toBe(1);

      // Wait for reindex to settle so the next iteration starts from a fresh vault state.
      // vault.reindexFile() is fire-and-forget; give it a tick.
      await new Promise((resolve) => setTimeout(resolve, 50));
      resetVaultFileReadStats();
    }

    // Aggregate check: K cycles completed with no cross-cycle leak detected above.
    const final = getVaultFileReadStats();
    expect(final).toEqual({ hits: 0, misses: 0, stale: 0 });
  });

  it('leaks nothing between runs after reset — counters start fresh each cycle', async () => {
    // Cycle 1 — deliberately exercise miss path.
    const outsideCtx: ToolContext = {
      projectPath: outsideDir,
      workingDirectory: outsideDir,
      readOnly: false,
      vaultRegistry: registry,
    };
    await tool.execute({ path: 'outside.ts', offset: 1, limit: 1 }, outsideCtx);
    await tool.execute({ path: 'outside.ts', offset: 1, limit: 1 }, outsideCtx);

    const cycle1 = getVaultFileReadStats();
    expect(cycle1.misses).toBe(2);

    resetVaultFileReadStats();
    expect(getVaultFileReadStats()).toEqual({ hits: 0, misses: 0, stale: 0 });

    // Cycle 2 — different path: warm vault then hit once.
    await tool.execute({ path: 'src/a.ts', offset: 1, limit: 5 }, ctx);
    resetVaultFileReadStats();
    await tool.execute({ path: 'src/a.ts', offset: 1, limit: 5 }, ctx);

    const cycle2 = getVaultFileReadStats();
    // Only the second call counts toward this cycle after reset.
    expect(cycle2.hits).toBe(1);
    expect(cycle2.misses).toBe(0);
    expect(cycle2.stale).toBe(0);
  });
});
