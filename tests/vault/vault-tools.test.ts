import { describe, it, expect, vi } from 'vitest';
import { VaultInitTool } from '../../src/agents/tools/vault-init-tool.js';
import { VaultSyncTool } from '../../src/agents/tools/vault-sync-tool.js';
import { VaultStatusTool } from '../../src/agents/tools/vault-status-tool.js';

const reg = {
  get: vi.fn(() => ({
    id: 'unity:abc',
    init: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue({ changed: 3, durationMs: 120 }),
    stats: vi.fn().mockResolvedValue({ fileCount: 10, chunkCount: 50, lastIndexedAt: 1, dbBytes: 2048 }),
  })),
  list: vi.fn(() => [{ id: 'unity:abc' }]),
} as any;

describe('vault tools', () => {
  it('VaultInitTool reports initialization', async () => {
    const t = new VaultInitTool(reg);
    const r = await t.execute({ vaultId: 'unity:abc' });
    expect(r.content).toMatch(/initialized/i);
  });
  it('VaultSyncTool shows changed-count', async () => {
    const t = new VaultSyncTool(reg);
    const r = await t.execute({ vaultId: 'unity:abc' });
    expect(r.content).toMatch(/3 .*file/i);
    expect(r.content).toMatch(/120/);
  });
  it('VaultStatusTool shows stats', async () => {
    const t = new VaultStatusTool(reg);
    const r = await t.execute({ vaultId: 'unity:abc' });
    expect(r.content).toMatch(/10 files/);
    expect(r.content).toMatch(/50 chunks/);
  });
});
