import { describe, it, expect, vi } from 'vitest';
import { VaultGraphExploreTool } from './vault-graph-explore-tool.js';
import type { ToolContext } from './tool.interface.js';

function makeVault(overrides: {
  id?: string;
  queryResult?: { hits: Array<{ chunk: { path: string; startLine: number; endLine: number; content: string } }>; budgetUsed: number; truncated: boolean };
  canvas?: { nodes: Array<{ id: string; file?: string }>; edges: Array<{ id: string; fromNode: string; toNode: string }> };
} = {}) {
  return {
    id: overrides.id ?? 'v1',
    query: vi.fn().mockResolvedValue(overrides.queryResult ?? { hits: [], budgetUsed: 0, truncated: false }),
    readCanvas: vi.fn().mockResolvedValue(overrides.canvas ?? { nodes: [], edges: [] }),
  } as never;
}

function makeContext(vaults: ReturnType<typeof makeVault>[]): ToolContext {
  return {
    vaultRegistry: {
      list: () => vaults,
      get: (id: string) => vaults.find((v) => v.id === id),
      resolveVaultForPath: (_path: string, _projectPath: string) => vaults[0] ?? undefined,
    } as never,
    projectPath: '/project',
  } as ToolContext;
}

describe('VaultGraphExploreTool', () => {
  const tool = new VaultGraphExploreTool();

  it('returns subgraph when hits match canvas nodes', async () => {
    const vault = makeVault({
      queryResult: {
        hits: [{ chunk: { path: 'Player.cs', startLine: 1, endLine: 10, content: 'class Player {}' } }],
        budgetUsed: 0,
        truncated: false,
      },
      canvas: {
        nodes: [
          { id: 'n1', file: 'Player.cs' },
          { id: 'n2', file: 'Controller.cs' },
          { id: 'n3', file: 'Enemy.cs' },
        ],
        edges: [
          { id: 'e1', fromNode: 'n1', toNode: 'n2' },
          { id: 'e2', fromNode: 'n2', toNode: 'n3' },
        ],
      },
    });

    const result = await tool.execute({ query: 'Player' }, makeContext([vault]));
    const data = JSON.parse(result.content);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].seedNodes).toContain('n1');
    expect(data.results[0].nodes).toHaveLength(2); // n1 + n2 (1-degree neighbour)
    expect(data.results[0].edges).toHaveLength(1); // e1 only
  });

  it('returns no graph context when canvas is empty', async () => {
    const vault = makeVault({
      queryResult: {
        hits: [{ chunk: { path: 'a.cs', startLine: 1, endLine: 1, content: '' } }],
        budgetUsed: 0,
        truncated: false,
      },
      canvas: { nodes: [], edges: [] },
    });

    const result = await tool.execute({ query: 'a' }, makeContext([vault]));
    expect(result.content).toMatch(/no graph context found/);
  });

  it('returns error when no vaults registered', async () => {
    const result = await tool.execute({ query: 'test' }, makeContext([]));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/no vaults registered/);
  });

  it('scopes to explicit vaultId', async () => {
    const v1 = makeVault({ id: 'v1' });
    const v2 = makeVault({ id: 'v2' });

    const result = await tool.execute(
      { query: 'x', vaultId: 'v2' },
      makeContext([v1, v2]),
    );
    expect(result.content).toMatch(/no graph context found/);
    expect(v1.query).not.toHaveBeenCalled();
    expect(v2.query).toHaveBeenCalled();
  });
});
