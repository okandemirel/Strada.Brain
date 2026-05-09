import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initObsidianVaultFromBootstrap, initSelfVaultFromBootstrap, initVaultsFromBootstrap } from '../../src/core/bootstrap-stages/stage-knowledge.js';
import { SelfVault } from '../../src/vault/self-vault.js';

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('starts SelfVault watcher when SelfVault is enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'self-boot-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;');
    const startWatch = vi.spyOn(SelfVault.prototype, 'startWatch').mockResolvedValue(undefined);
    const registry = { register: vi.fn() } as any;
    try {
      await initSelfVaultFromBootstrap({
        config: { vault: { enabled: false, self: { enabled: true } } },
        vaultRegistry: registry,
        embedding: { model: 'stub', dim: 4, embed: async (xs: string[]) => xs.map(() => new Float32Array(4)) },
        vectorStore: { add: () => 1, remove: () => {}, search: () => [] },
        repoRoot: dir,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(registry.register).toHaveBeenCalledTimes(1);
    expect(startWatch).toHaveBeenCalled();
  });

  it('registers ObsidianVault from obsidian config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obsidian-boot-'));
    writeFileSync(join(dir, 'Note.md'), '# Note');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const registry = { register: vi.fn() } as any;
    try {
      await initObsidianVaultFromBootstrap({
        config: {
          obsidian: {
            enabled: true,
            apiUrl: 'http://127.0.0.1:9',
            apiKey: 'test',
            vaultPath: dir,
          },
        },
        vaultRegistry: registry,
        embedding: { model: 'stub', dim: 4, embed: async (xs: string[]) => xs.map(() => new Float32Array(4)) },
        vectorStore: { add: () => 1, remove: () => {}, search: () => [] },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(registry.register).toHaveBeenCalledTimes(1);
  });
});
