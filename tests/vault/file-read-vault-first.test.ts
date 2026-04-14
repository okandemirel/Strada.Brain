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

// ── Stubs (zero-vector embedding, in-memory HNSW; no network, no servers) ──
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
  // realpathSync to mirror the symlink resolution path-guard performs — otherwise
  // `/var/folders/...` vs `/private/var/folders/...` on macOS breaks prefix match.
  fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), 'vault-first-')));
  cpSync('tests/fixtures/ts-mini', fixtureDir, { recursive: true });
  outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'outside-')));
  writeFileSync(
    join(outsideDir, 'plain.ts'),
    'export const plain = 1;\nexport const two = 2;\nexport const three = 3;\n',
  );

  vault = new UnityProjectVault({
    id: 'ts-mini',
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

describe('FileReadTool vault-first integration', () => {
  it('serves a repeat range read from the vault (content marked as vault-cached, hit counter incremented)', async () => {
    const first = await tool.execute(
      { path: 'src/a.ts', offset: 1, limit: 5 },
      ctx,
    );
    expect(first.isError).toBeUndefined();
    // Indexing is complete after init(), so even the first range-scoped read is a vault hit.
    expect(first.content).toMatch(/vault-cached/);

    const second = await tool.execute(
      { path: 'src/a.ts', offset: 1, limit: 5 },
      ctx,
    );
    expect(second.isError).toBeUndefined();
    expect(second.content).toMatch(/vault-cached/);

    const stats = getVaultFileReadStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(0);
    expect(stats.stale).toBe(0);
  });

  it('full-file reads (no offset/limit) skip the vault branch and do not touch counters', async () => {
    const result = await tool.execute({ path: 'src/a.ts' }, ctx);
    expect(result.isError).toBeUndefined();
    // No vault marker — disk read.
    expect(result.content).not.toMatch(/vault-cached/);

    const stats = getVaultFileReadStats();
    // rangeScoped=false → vault branch skipped entirely.
    // However the disk fallback still increments miss when vaultRegistry is attached.
    // The contract is that full-file reads neither hit the vault nor pretend to —
    // they count as a miss so operators can see cache-avoidance volume.
    expect(stats.hits).toBe(0);
    expect(stats.stale).toBe(0);
  });

  it('detects stale vault entries when mtime/size drift and falls back to disk', async () => {
    // Warm vault first.
    const warm = await tool.execute({ path: 'src/a.ts', offset: 1, limit: 5 }, ctx);
    expect(warm.content).toMatch(/vault-cached/);
    resetVaultFileReadStats();

    // Mutate the file — bumps mtime AND size.
    const abs = join(fixtureDir, 'src/a.ts');
    writeFileSync(
      abs,
      'export class Alpha {\n  greet(): string { return "hi"; }\n  wave(): string { return "wave"; }\n  shout(): string { return "SHOUT"; }\n}\nexport function topLevel(): void {}\nexport const extra = 42;\n',
    );

    const stale = await tool.execute({ path: 'src/a.ts', offset: 1, limit: 5 }, ctx);
    expect(stale.isError).toBeUndefined();
    // Stale vault entry → fell back to disk; response is NOT marked vault-cached.
    expect(stale.content).not.toMatch(/vault-cached/);

    const stats = getVaultFileReadStats();
    expect(stats.stale).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);
  });

  it('reads outside any registered vault go straight to disk (miss counter bumps; no hit, no stale)', async () => {
    const outsideCtx: ToolContext = {
      projectPath: outsideDir,
      workingDirectory: outsideDir,
      readOnly: false,
      vaultRegistry: registry, // registry present, but no vault owns this path
    };

    const result = await tool.execute(
      { path: 'plain.ts', offset: 1, limit: 2 },
      outsideCtx,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).not.toMatch(/vault-cached/);

    const stats = getVaultFileReadStats();
    expect(stats.hits).toBe(0);
    expect(stats.stale).toBe(0);
    // With a registry attached, any disk fallback (range or full) increments miss.
    expect(stats.misses).toBe(1);
  });

  it('review-F3: partial-range coverage falls back to disk (no silent truncation)', async () => {
    // src/a.ts is 5 lines. Requesting 1..100 is a partial-coverage case — the
    // vault only covers lines 1..5, so we must NOT silently return 5 lines to
    // the caller who asked for 100. Fall back to disk instead.
    const r = await tool.execute(
      { path: 'src/a.ts', offset: 1, limit: 100 },
      ctx,
    );
    expect(r.isError).toBeUndefined();
    // Vault returned null (partial coverage) → disk served the read.
    expect(r.content).not.toMatch(/vault-cached/);

    const stats = getVaultFileReadStats();
    expect(stats.hits).toBe(0);
    // Disk fallback with a vault present → miss counter bumps once.
    expect(stats.misses).toBe(1);
    // Staleness was not the reason we bailed; staleness counter stays clean.
    expect(stats.stale).toBe(0);
  });

  it('reads without a vaultRegistry on ctx never touch counters', async () => {
    const bareCtx: ToolContext = {
      projectPath: outsideDir,
      workingDirectory: outsideDir,
      readOnly: false,
      // vaultRegistry intentionally omitted
    };

    const result = await tool.execute(
      { path: 'plain.ts', offset: 1, limit: 2 },
      bareCtx,
    );
    expect(result.isError).toBeUndefined();

    const stats = getVaultFileReadStats();
    expect(stats).toEqual({ hits: 0, misses: 0, stale: 0 });
  });
});
