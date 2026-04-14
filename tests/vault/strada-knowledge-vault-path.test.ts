import { describe, it, expect, vi } from 'vitest';
import { buildProjectContext } from '../../src/agents/context/strada-knowledge.js';

describe('buildProjectContext with vault flag', () => {
  it('uses vault.query when enabled', async () => {
    const query = vi.fn().mockResolvedValue({
      hits: [{ chunk: { chunkId: 'c1', path: 'Player.cs', startLine: 1, endLine: 5, content: 'class Player {}', tokenCount: 4 }, scores: { fts: 1, hnsw: 0.9, rrf: 0.1 } }],
      budgetUsed: 4, truncated: false,
    });
    const ctx = {
      config: { vault: { enabled: true } },
      vaultRegistry: { list: () => [{ id: 'a', kind: 'unity-project', query }] },
      userMessage: 'how does Player work',
      contextBudget: 2000,
    } as any;
    const r = await buildProjectContext(ctx);
    expect(query).toHaveBeenCalled();
    expect(r).toContain('Player.cs');
  });

  it('falls back when disabled', async () => {
    const query = vi.fn();
    const r = await buildProjectContext({
      config: { vault: { enabled: false } },
      vaultRegistry: { list: () => [{ query }] },
      userMessage: 'q',
      contextBudget: 100,
      legacyBuildProjectContext: async () => 'LEGACY',
    } as any);
    expect(query).not.toHaveBeenCalled();
    expect(r).toBe('LEGACY');
  });

  it('legacy string overload still works (back-compat)', () => {
    const s = buildProjectContext('/some/path');
    expect(s).toContain('/some/path');
    expect(s).toContain('Current Project');
  });
});
