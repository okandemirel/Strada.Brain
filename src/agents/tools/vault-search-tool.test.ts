import { describe, it, expect, vi } from 'vitest';
import { VaultSearchTool } from './vault-search-tool.js';
import type { ToolContext } from './tool.interface.js';
import type { VaultKind } from '../../vault/vault.interface.js';

const EMPTY_RESULT = { hits: [], budgetUsed: 0, truncated: false };

function makeVault(id: string, kind: VaultKind, rootPath = '/project') {
  return {
    id,
    kind,
    rootPath,
    query: vi.fn().mockResolvedValue(EMPTY_RESULT),
  } as never;
}

function makeContext(
  vaults: ReturnType<typeof makeVault>[],
  projectVaultId: string | undefined,
): ToolContext {
  return {
    vaultRegistry: {
      list: () => vaults,
      get: (id: string) => vaults.find((v) => (v as { id: string }).id === id),
      resolve: (id: string) =>
        vaults.find((v) => (v as { id: string }).id === id) ??
        vaults.find((v) => (v as { kind?: string }).kind === id) ??
        vaults.find((v) => (v as { id: string }).id.startsWith(`${id}:`)),
      ids: () => vaults.map((v) => (v as { id: string }).id),
      resolveVaultForPath: () =>
        projectVaultId ? vaults.find((v) => (v as { id: string }).id === projectVaultId) : undefined,
    } as never,
    projectPath: '/project',
  } as ToolContext;
}

describe('VaultSearchTool default vault targeting', () => {
  const tool = new VaultSearchTool();

  it('targets BOTH the project code vault and a registered knowledge vault by default', async () => {
    const code = makeVault('project', 'unity-project');
    const knowledge = makeVault('dev-knowledge', 'knowledge');
    const ctx = makeContext([code, knowledge], 'project');

    const result = await tool.execute({ query: 'how does foo work' }, ctx);

    // Both vaults were queried.
    expect((code as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalledTimes(1);
    expect((knowledge as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalledTimes(1);
    // The "searched" set surfaced to the agent lists both vault ids.
    expect(result.content).toContain('project');
    expect(result.content).toContain('dev-knowledge');
  });

  it('targets ONLY the project vault when no knowledge vault is registered (regression guard)', async () => {
    const code = makeVault('project', 'unity-project');
    const self = makeVault('self', 'self'); // present but NOT a knowledge vault
    const ctx = makeContext([code, self], 'project');

    await tool.execute({ query: 'how does foo work' }, ctx);

    expect((code as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalledTimes(1);
    // SelfVault must NOT be queried by default — scoping is preserved.
    expect((self as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
  });

  it('does not search the project vault twice when it is itself a knowledge vault (dedupe)', async () => {
    // The resolved project vault is kind === 'knowledge'; it must appear once.
    const code = makeVault('project', 'knowledge');
    const ctx = makeContext([code], 'project');

    const result = await tool.execute({ query: 'how does foo work' }, ctx);

    expect((code as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalledTimes(1);
    const searchedCount = (result.content.match(/project/g) ?? []).length;
    expect(searchedCount).toBe(1);
  });

  it('excludes a knowledge vault rooted OUTSIDE the project (sec-H2 scoping)', async () => {
    const code = makeVault('project', 'unity-project');
    const foreign = makeVault(
      'other-knowledge',
      'knowledge',
      '/other-project/.strada/knowledge',
    );
    const ctx = makeContext([code, foreign], 'project');

    await tool.execute({ query: 'how does foo work' }, ctx);

    expect((code as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalledTimes(1);
    // A knowledge vault belonging to a different project must NOT be searched
    // by default — the sec-H2 containment guard confines the union to vaults
    // rooted inside the current projectPath.
    expect(
      (foreign as { query: ReturnType<typeof vi.fn> }).query,
    ).not.toHaveBeenCalled();
  });

  it('still honours an explicit vaultId (broadening only affects the default)', async () => {
    const code = makeVault('project', 'unity-project');
    const knowledge = makeVault('dev-knowledge', 'knowledge');
    const ctx = makeContext([code, knowledge], 'project');

    await tool.execute({ query: 'how does foo work', vaultId: 'dev-knowledge' }, ctx);

    // Explicit target only — the project code vault is NOT pulled in.
    expect((knowledge as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalledTimes(1);
    expect((code as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
  });
});
