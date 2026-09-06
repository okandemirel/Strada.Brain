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

/**
 * Audited 2026-09-02: a vault whose query() rejected was dropped silently while
 * `searched` still listed it, so "no vault hits ... across [a, b]" read as a
 * genuine empty index when b was never searched at all.
 */
describe('VaultSearchTool when a vault query throws', () => {
  const tool = new VaultSearchTool();

  function rejectingVault(id: string, reason: string, kind: VaultKind = 'unity-project') {
    return {
      id,
      kind,
      rootPath: '/project',
      query: vi.fn().mockRejectedValue(new Error(reason)),
    } as never;
  }

  function hittingVault(id: string) {
    return {
      id,
      kind: 'knowledge',
      rootPath: '/project',
      query: vi.fn().mockResolvedValue({
        hits: [{
          chunk: { path: 'notes/dash.md', startLine: 1, endLine: 3, content: 'dash notes' },
          scores: { fts: 2.1, hnsw: null, rrf: 0.016 },
        }],
        budgetUsed: 10,
        truncated: false,
      }),
    } as never;
  }

  it('does not list a vault that threw as searched, and names the failure', async () => {
    const broken = rejectingVault('project', 'SQLITE_BUSY: database is locked');
    const empty = makeVault('dev-knowledge', 'knowledge');
    const ctx = makeContext([broken, empty], 'project');

    const result = await tool.execute({ query: 'PlayerController dash' }, ctx);

    expect(result.content).toContain('across [dev-knowledge]');
    expect(result.content).not.toContain('across [project, dev-knowledge]');
    expect(result.content).toContain('project: SQLITE_BUSY: database is locked');
    expect(result.content).toMatch(/not searched/u);
  });

  it('is an error, not "no hits", when every target vault rejected the query', async () => {
    const a = rejectingVault('project', 'empty_query');
    const b = rejectingVault('dev-knowledge', 'empty_query', 'knowledge');
    const ctx = makeContext([a, b], 'project');

    const result = await tool.execute({ query: '()' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).not.toMatch(/no vault hits/u);
    expect(result.content).toContain('project: empty_query');
    expect(result.content).toContain('dev-knowledge: empty_query');
  });

  it('reports the failed vault next to the surviving hits', async () => {
    const broken = rejectingVault('project', 'store closed');
    const ok = hittingVault('dev-knowledge');
    const ctx = makeContext([broken, ok], 'project');

    const result = await tool.execute({ query: 'PlayerController dash' }, ctx);

    expect(result.content).toContain('1 hit(s)');
    expect(result.content).toContain('searched=[dev-knowledge]');
    expect(result.content).toContain('failed=[project: store closed]');
  });
});

/**
 * Audited 2026-09-02: every vault store the shipped bootstrap wires is
 * `semantic: false`, so no hit ever carries an hnsw score. mode='semantic'
 * then dropped every hit and answered "no vault hits" for a corpus that
 * hybrid and fts both found.
 */
describe("VaultSearchTool mode='semantic' without a vector backend", () => {
  const tool = new VaultSearchTool();

  function vaultWithScores(id: string, scores: { fts: number | null; hnsw: number | null; rrf: number }) {
    return {
      id,
      kind: 'unity-project',
      rootPath: '/project',
      query: vi.fn().mockResolvedValue({
        hits: [{
          chunk: { path: 'Assets/EntitySpawnSystem.cs', startLine: 1, endLine: 9, content: 'class EntitySpawnSystem {}' },
          scores,
        }],
        budgetUsed: 10,
        truncated: false,
      }),
    } as never;
  }

  it('says the semantic channel is unavailable instead of reporting an empty index', async () => {
    const vault = vaultWithScores('project', { fts: 3.2, hnsw: null, rrf: 0.016 });
    const ctx = makeContext([vault], 'project');

    const semantic = await tool.execute({ query: 'entity spawn system', mode: 'semantic' }, ctx);
    const hybrid = await tool.execute({ query: 'entity spawn system', mode: 'hybrid' }, ctx);

    expect(semantic.content).toMatch(/semantic retrieval unavailable/u);
    expect(semantic.content).not.toMatch(/no vault hits/u);
    expect(semantic.content).toContain("mode='hybrid'");
    expect(hybrid.content).toContain('1 hit(s)');
  });

  it('still returns semantic hits when a vault does score them', async () => {
    const vault = vaultWithScores('project', { fts: null, hnsw: 0.91, rrf: 0.016 });
    const ctx = makeContext([vault], 'project');

    const result = await tool.execute({ query: 'entity spawn system', mode: 'semantic' }, ctx);

    expect(result.content).toContain('1 hit(s)');
    expect(result.content).toContain('source=semantic');
  });
});

describe("vaultId 'project'", () => {
  // Measured 2026-09-06 as a failed call ("vault not found: project"): it is
  // the omitted-id default by another name.
  it('queries exactly the project vault', async () => {
    const project = makeVault('unity:4ca9bd33', 'unity');
    const self = makeVault('self:strada-brain', 'self' as VaultKind);
    const ctx = makeContext([self, project], 'unity:4ca9bd33');
    const result = await new VaultSearchTool().execute({ query: 'GameBootstrapper', vaultId: 'project' }, ctx);
    expect(result.isError).toBeFalsy();
    expect((project as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalled();
    expect((self as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
  });
});
