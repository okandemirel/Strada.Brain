import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VaultSearchTool } from '../../src/agents/tools/vault-search-tool.js';
import { VaultRegistry } from '../../src/vault/vault-registry.js';
import type {
  IVault,
  VaultChunk,
  VaultHit,
  VaultQuery,
  VaultQueryResult,
  VaultFile,
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
  rootPath?: string;
  hits: VaultHit[];
  truncated?: boolean;
}

function makeFakeVault(opts: FakeVaultOptions): IVault & { queryMock: ReturnType<typeof vi.fn> } {
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
    rootPath: opts.rootPath ?? `/tmp/${opts.id}`,
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

describe('VaultSearchTool', () => {
  let registry: VaultRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    registry = new VaultRegistry();
    ctx = {
      projectPath: '/tmp/project',
      workingDirectory: '/tmp/project',
      readOnly: false,
      vaultRegistry: registry,
    };
  });

  describe('input validation', () => {
    it('rejects empty query', async () => {
      const tool = new VaultSearchTool();
      const vault = makeFakeVault({ id: 'v1', hits: [] });
      registry.register(vault);

      const r = await tool.execute({ query: '' }, ctx);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/at least .* characters/i);
    });

    it('rejects query shorter than minimum length', async () => {
      const tool = new VaultSearchTool();
      const vault = makeFakeVault({ id: 'v1', hits: [] });
      registry.register(vault);

      const r = await tool.execute({ query: 'a' }, ctx);
      expect(r.isError).toBe(true);
    });

    it('accepts valid query of exactly minimum length', async () => {
      const tool = new VaultSearchTool();
      const vault = makeFakeVault({ id: 'v1', hits: [] });
      registry.register(vault);

      const r = await tool.execute({ query: 'ok' }, ctx);
      expect(r.isError).toBeUndefined();
    });

    it('coerces unknown mode values to hybrid', async () => {
      const tool = new VaultSearchTool();
      const vault = makeFakeVault({
        id: 'v1',
        hits: [
          mkHit(mkChunk('c1', 'src/a.ts', 1, 3, 'hybrid-chunk'), {
            fts: 0.5,
            hnsw: 0.8,
            rrf: 0.9,
          }),
        ],
      });
      registry.register(vault);

      const r = await tool.execute({ query: 'hello', mode: 'not-a-real-mode' }, ctx);
      expect(r.isError).toBeUndefined();
      // Hybrid mode keeps the hit regardless of channel presence.
      expect(r.content).toContain('hybrid-chunk');
    });
  });

  describe('delegation', () => {
    it('returns top-K hits with file:start-end citation format and itemsAffected metadata', async () => {
      const tool = new VaultSearchTool();
      const vault = makeFakeVault({
        id: 'v1',
        rootPath: '/tmp/v1',
        hits: [
          mkHit(mkChunk('c1', 'src/a.ts', 10, 20, 'alpha-body'), {
            fts: 0.9,
            hnsw: 0.8,
            rrf: 0.95,
          }),
          mkHit(mkChunk('c2', 'src/b.ts', 1, 5, 'beta-body'), {
            fts: 0.7,
            hnsw: 0.6,
            rrf: 0.85,
          }),
          mkHit(mkChunk('c3', 'src/c.ts', 30, 40, 'gamma-body'), {
            fts: 0.5,
            hnsw: 0.4,
            rrf: 0.75,
          }),
          mkHit(mkChunk('c4', 'src/d.ts', 50, 60, 'delta-body'), {
            fts: 0.3,
            hnsw: 0.2,
            rrf: 0.5,
          }),
        ],
      });
      registry.register(vault);

      const r = await tool.execute({ query: 'pattern', topK: 3 }, ctx);
      expect(r.isError).toBeUndefined();
      expect(r.metadata?.itemsAffected).toBe(3);
      expect(typeof r.metadata?.executionTimeMs).toBe('number');
      expect(r.metadata?.truncated).toBe(true); // 4 merged → capped to 3
      expect(typeof r.metadata?.tokensUsed).toBe('number');

      // Citation format file:start-end present
      expect(r.content).toContain('src/a.ts:10-20');
      expect(r.content).toContain('src/b.ts:1-5');
      expect(r.content).toContain('src/c.ts:30-40');
      // Fourth hit cut by topK cap
      expect(r.content).not.toContain('src/d.ts:50-60');
    });
  });

  describe('mode filtering', () => {
    const ftsOnly = mkHit(mkChunk('fts-c', 'fts.ts', 1, 2, 'fts-only-content'), {
      fts: 0.9,
      hnsw: null,
      rrf: 0.5,
    });
    const semanticOnly = mkHit(
      mkChunk('sem-c', 'sem.ts', 1, 2, 'semantic-only-content'),
      { fts: null, hnsw: 0.9, rrf: 0.5 },
    );
    const both = mkHit(mkChunk('both-c', 'both.ts', 1, 2, 'both-content'), {
      fts: 0.8,
      hnsw: 0.85,
      rrf: 0.95,
    });

    it('fts mode drops hits with no FTS score', async () => {
      const tool = new VaultSearchTool();
      const vault = makeFakeVault({ id: 'v1', hits: [ftsOnly, semanticOnly, both] });
      registry.register(vault);

      const r = await tool.execute({ query: 'xx', mode: 'fts' }, ctx);
      expect(r.content).toContain('fts-only-content');
      expect(r.content).toContain('both-content');
      expect(r.content).not.toContain('semantic-only-content');
    });

    it('semantic mode drops hits with no HNSW score', async () => {
      const tool = new VaultSearchTool();
      const vault = makeFakeVault({ id: 'v1', hits: [ftsOnly, semanticOnly, both] });
      registry.register(vault);

      const r = await tool.execute({ query: 'xx', mode: 'semantic' }, ctx);
      expect(r.content).toContain('semantic-only-content');
      expect(r.content).toContain('both-content');
      expect(r.content).not.toContain('fts-only-content');
    });

    it('hybrid mode fuses everything via RRF', async () => {
      const tool = new VaultSearchTool();
      const vault = makeFakeVault({ id: 'v1', hits: [ftsOnly, semanticOnly, both] });
      registry.register(vault);

      const r = await tool.execute({ query: 'xx', mode: 'hybrid' }, ctx);
      expect(r.content).toContain('fts-only-content');
      expect(r.content).toContain('semantic-only-content');
      expect(r.content).toContain('both-content');
      expect(r.metadata?.itemsAffected).toBe(3);
    });
  });

  describe('ctx guards', () => {
    it('returns a graceful (non-throwing) result when no vault registry on ctx and no fallback', async () => {
      const tool = new VaultSearchTool();
      const bareCtx: ToolContext = {
        projectPath: '/tmp',
        workingDirectory: '/tmp',
        readOnly: false,
      };

      const r = await tool.execute({ query: 'hello' }, bareCtx);
      // Must not throw; must report a clear status.
      expect(r.isError).not.toBe(true);
      expect(r.content).toMatch(/vault unavailable|no vault registry/i);
    });

    it('reports no vaults registered when registry is empty', async () => {
      const tool = new VaultSearchTool();
      const r = await tool.execute({ query: 'hello' }, ctx);
      expect(r.content).toMatch(/no vaults registered/i);
    });

    it('reports vault not found when vaultId targets a missing vault', async () => {
      const tool = new VaultSearchTool();
      const vault = makeFakeVault({ id: 'v1', hits: [] });
      registry.register(vault);

      const r = await tool.execute({ query: 'hello', vaultId: 'does-not-exist' }, ctx);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/vault not found/i);
    });
  });

  describe('vaultId targeting', () => {
    it('queries only the targeted vault when vaultId is provided', async () => {
      const tool = new VaultSearchTool();

      const vaultA = makeFakeVault({
        id: 'vaultA',
        hits: [
          mkHit(mkChunk('c1', 'a.ts', 1, 2, 'from-A'), {
            fts: 0.9,
            hnsw: 0.9,
            rrf: 0.95,
          }),
        ],
      });
      const vaultB = makeFakeVault({
        id: 'vaultB',
        hits: [
          mkHit(mkChunk('c2', 'b.ts', 1, 2, 'from-B'), {
            fts: 0.9,
            hnsw: 0.9,
            rrf: 0.95,
          }),
        ],
      });
      registry.register(vaultA);
      registry.register(vaultB);

      const r = await tool.execute({ query: 'pattern', vaultId: 'vaultA' }, ctx);
      expect(r.isError).toBeUndefined();
      expect(vaultA.queryMock).toHaveBeenCalledTimes(1);
      expect(vaultB.queryMock).toHaveBeenCalledTimes(0);
      expect(r.content).toContain('from-A');
      expect(r.content).not.toContain('from-B');
    });

    it('queries all registered vaults when vaultId is omitted', async () => {
      const tool = new VaultSearchTool();

      const vaultA = makeFakeVault({
        id: 'vaultA',
        hits: [
          mkHit(mkChunk('c1', 'a.ts', 1, 2, 'from-A'), {
            fts: 0.9,
            hnsw: 0.9,
            rrf: 0.95,
          }),
        ],
      });
      const vaultB = makeFakeVault({
        id: 'vaultB',
        hits: [
          mkHit(mkChunk('c2', 'b.ts', 1, 2, 'from-B'), {
            fts: 0.9,
            hnsw: 0.9,
            rrf: 0.95,
          }),
        ],
      });
      registry.register(vaultA);
      registry.register(vaultB);

      const r = await tool.execute({ query: 'pattern' }, ctx);
      expect(r.isError).toBeUndefined();
      expect(vaultA.queryMock).toHaveBeenCalledTimes(1);
      expect(vaultB.queryMock).toHaveBeenCalledTimes(1);
      expect(r.content).toContain('from-A');
      expect(r.content).toContain('from-B');
    });
  });
});
