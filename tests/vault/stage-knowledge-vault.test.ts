import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initVaultsFromBootstrap } from '../../src/core/bootstrap-stages/stage-knowledge.js';

describe('stage-knowledge vault init', () => {
  it('registers a UnityProjectVault when enabled + project detected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boot-'));
    cpSync('tests/fixtures/unity-mini', dir, { recursive: true });
    const registry = { register: vi.fn(), list: () => [] } as any;
    await initVaultsFromBootstrap({
      config: { vault: { enabled: true, debounceMs: 100, writeHookBudgetMs: 200 }, unityProjectPath: dir },
      vaultRegistry: registry,
      embedding: { model: 'stub', dim: 4, embed: async (xs: string[]) => xs.map(() => new Float32Array(4)) },
      vectorStore: { add: () => 1, remove: () => {}, search: () => [] },
    });
    expect(registry.register).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when disabled', async () => {
    const registry = { register: vi.fn() } as any;
    await initVaultsFromBootstrap({
      config: { vault: { enabled: false } },
      vaultRegistry: registry,
      embedding: {} as any, vectorStore: {} as any,
    });
    expect(registry.register).not.toHaveBeenCalled();
  });
});
