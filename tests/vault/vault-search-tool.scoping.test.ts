import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VaultSearchTool } from '../../src/agents/tools/vault-search-tool.js';
import { VaultRegistry } from '../../src/vault/vault-registry.js';
import type {
  IVault,
  VaultChunk,
  VaultFile,
  VaultHit,
  VaultQuery,
  VaultQueryResult,
  VaultStats,
  VaultId,
  VaultKind,
} from '../../src/vault/vault.interface.js';
import type { ToolContext } from '../../src/agents/tools/tool.interface.js';

// ── Minimal in-memory vault fake with spyable query() ─────────────────────
function mkChunk(
  chunkId: string,
  path: string,
  startLine: number,
  endLine: number,
  content: string,
): VaultChunk {
  return {
    chunkId,
    path,
    startLine,
    endLine,
    content,
    tokenCount: Math.max(1, Math.ceil(content.length / 4)),
  };
}

function mkHit(
  chunk: VaultChunk,
  scores: { fts: number | null; hnsw: number | null; rrf: number },
): VaultHit {
  return { chunk, scores };
}

interface FakeVaultOptions {
  id: VaultId;
  kind?: VaultKind;
  rootPath: string;
  hits: VaultHit[];
  truncated?: boolean;
}

function makeFakeVault(
  opts: FakeVaultOptions,
): IVault & { queryMock: ReturnType<typeof vi.fn> } {
  const hits = opts.hits;
  const queryMock = vi.fn(
    async (_q: VaultQuery): Promise<VaultQueryResult> => ({
      hits,
      budgetUsed: hits.reduce((a, h) => a + h.chunk.tokenCount, 0),
      truncated: opts.truncated ?? false,
    }),
  );
  const vault: IVault & { queryMock: ReturnType<typeof vi.fn> } = {
    id: opts.id,
    kind: opts.kind ?? 'unity-project',
    rootPath: opts.rootPath,
    async init(): Promise<void> {},
    async sync() {
      return { changed: 0, durationMs: 0 };
    },
    async rebuild(): Promise<void> {},
    query: queryMock as unknown as IVault['query'],
    async stats(): Promise<VaultStats> {
      return { fileCount: 0, chunkCount: 0, lastIndexedAt: null, dbBytes: 0 };
    },
    async dispose(): Promise<void> {},
    listFiles(): VaultFile[] {
      return [];
    },
    async readFile(): Promise<string> {
      return '';
    },
    onUpdate(): () => void {
      return () => {};
    },
    queryMock,
  };
  return vault;
}

describe('VaultSearchTool — default scoping (sec-H3)', () => {
  let registry: VaultRegistry;
  let projectVault: IVault & { queryMock: ReturnType<typeof vi.fn> };
  let selfVault: IVault & { queryMock: ReturnType<typeof vi.fn> };
  let ctx: ToolContext;

  const PROJECT_PATH = '/tmp/scoping-project';
  const SELF_PATH = '/tmp/scoping-self';

  beforeEach(() => {
    registry = new VaultRegistry();

    projectVault = makeFakeVault({
      id: 'project',
      kind: 'unity-project',
      rootPath: PROJECT_PATH,
      hits: [
        mkHit(mkChunk('pc1', 'src/proj.ts', 1, 3, 'from-project-vault'), {
          fts: 0.9,
          hnsw: 0.9,
          rrf: 0.95,
        }),
      ],
    });

    selfVault = makeFakeVault({
      id: 'self',
      kind: 'self',
      rootPath: SELF_PATH,
      hits: [
        mkHit(mkChunk('sc1', 'src/self.ts', 1, 3, 'from-self-vault'), {
          fts: 0.9,
          hnsw: 0.9,
          rrf: 0.95,
        }),
      ],
    });

    registry.register(projectVault);
    registry.register(selfVault);

    ctx = {
      projectPath: PROJECT_PATH,
      workingDirectory: PROJECT_PATH,
      readOnly: false,
      vaultRegistry: registry,
    };
  });

  it('(a) no vaultId + project vault exists → queries ONLY the project vault', async () => {
    const tool = new VaultSearchTool();
    const r = await tool.execute({ query: 'anything' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(projectVault.queryMock).toHaveBeenCalledTimes(1);
    expect(selfVault.queryMock).toHaveBeenCalledTimes(0);
    expect(r.content).toContain('from-project-vault');
    expect(r.content).not.toContain('from-self-vault');
  });

  it("(b) explicit vaultId 'self' → queries ONLY the self vault (crosses roots)", async () => {
    const tool = new VaultSearchTool();
    const r = await tool.execute({ query: 'anything', vaultId: 'self' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(selfVault.queryMock).toHaveBeenCalledTimes(1);
    expect(projectVault.queryMock).toHaveBeenCalledTimes(0);
    expect(r.content).toContain('from-self-vault');
    expect(r.content).not.toContain('from-project-vault');
  });

  it('(c) no vaultId + projectPath has no indexed vault → falls back to all vaults and emits a hint', async () => {
    const outsideCtx: ToolContext = {
      projectPath: '/tmp/unindexed-project',
      workingDirectory: '/tmp/unindexed-project',
      readOnly: false,
      vaultRegistry: registry,
    };
    const tool = new VaultSearchTool();
    const r = await tool.execute({ query: 'anything' }, outsideCtx);
    expect(r.isError).toBeUndefined();
    expect(projectVault.queryMock).toHaveBeenCalledTimes(1);
    expect(selfVault.queryMock).toHaveBeenCalledTimes(1);
    // Hint is surfaced in the formatted output.
    expect(r.content).toMatch(/hint:.*No vault indexed for projectPath/i);
  });

  it('(d) no projectPath on context → falls back to all vaults (legacy behavior)', async () => {
    const bareCtx: ToolContext = {
      projectPath: '',
      workingDirectory: '',
      readOnly: false,
      vaultRegistry: registry,
    };
    const tool = new VaultSearchTool();
    const r = await tool.execute({ query: 'anything' }, bareCtx);
    expect(r.isError).toBeUndefined();
    expect(projectVault.queryMock).toHaveBeenCalledTimes(1);
    expect(selfVault.queryMock).toHaveBeenCalledTimes(1);
  });
});
