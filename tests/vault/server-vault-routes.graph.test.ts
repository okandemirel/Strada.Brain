import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { handleVaultRoutes } from '../../src/dashboard/server-vault-routes.js';
import type { RouteContext } from '../../src/dashboard/server-types.js';
import type { IAIProvider } from '../../src/agents/providers/provider.interface.js';

/**
 * Drives the production raw-http `handleVaultRoutes` with a mock
 * IncomingMessage/ServerResponse (the old `registerVaultRoutes` Express adapter
 * was removed). Captures the JSON status + body.
 */
function callRoute(
  ctx: RouteContext,
  url: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const captured = { status: 200, body: undefined as any };
    const res = {
      writeHead(status: number) {
        captured.status = status;
        return res;
      },
      end(s?: string) {
        if (typeof s === 'string') {
          try { captured.body = JSON.parse(s); } catch { captured.body = s; }
        }
        resolve(captured);
      },
    };
    const req = Readable.from(body !== undefined ? [Buffer.from(JSON.stringify(body))] : []);
    const handled = handleVaultRoutes(url, method, req as never, res as never, ctx);
    if (!handled) resolve({ status: 0, body: { __unhandled: true } });
  });
}

const canvas = {
  nodes: [{ id: 'a', type: 'text', text: '**class** Foo', x: 0, y: 0, width: 100, height: 60, file: 'a.ts' }],
  edges: [],
};

const fakeLLMProvider = {
  name: 'mock',
  capabilities: { contextWindow: 128000, vision: false, thinkingSupported: false, toolCalling: false, streaming: false },
  chat: async () => ({ text: 'Manages player movement.', toolCalls: [], stopReason: 'stop', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
} as unknown as IAIProvider;

const fakeVault = {
  id: 'v', kind: 'unity-project', rootPath: '/tmp',
  readCanvas: async () => canvas,
  findCallers: async (id: string) =>
    id === 'missing'
      ? []
      : [{ fromSymbol: 'csharp::a.cs::Caller', toSymbol: id, kind: 'calls' as const, atLine: 7 }],
  findSymbolsByName: async (name: string) =>
    name === 'Move'
      ? [{ symbolId: 'csharp::a.cs::Move', name: 'Move', path: 'a.cs', kind: 'method', display: 'Move', startLine: 1, endLine: 1, doc: null }]
      : [],
  listBacklinks: async (path: string) =>
    path === 'n1.md'
      ? { wikilinks: [{ fromNote: 'n2.md', target: 'n1.md', resolved: true }], callers: [] }
      : { wikilinks: [], callers: [] },
  stats: async () => ({ fileCount: 0, chunkCount: 0, lastIndexedAt: null, dbBytes: 0 }),
  listFiles: () => [],
  readFile: async (path: string) => path === 'a.cs' ? 'public class Move { }' : '',
  query: async () => ({ hits: [], budgetUsed: 0, truncated: false }),
  sync: async () => ({ changed: 0, durationMs: 0 }),
};

const reg = {
  list: () => [fakeVault],
  get: (id: string) => id === 'v' ? fakeVault : undefined,
};

const ctx = (extra?: Record<string, unknown>): RouteContext =>
  ({ vaultRegistry: reg, ...extra } as unknown as RouteContext);

describe('vault routes — graph endpoints', () => {
  it('GET /api/vaults/:id/canvas returns the canvas JSON', async () => {
    const r = await callRoute(ctx(), '/api/vaults/v/canvas', 'GET');
    expect(r.status).toBe(200);
    expect(r.body).toEqual(canvas);
  });

  it('GET /api/vaults/:id/symbols/by-name returns matches', async () => {
    const r = await callRoute(ctx(), '/api/vaults/v/symbols/by-name?q=Move', 'GET');
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].name).toBe('Move');
  });

  it('GET /api/vaults/:id/symbols/:symbolId/callers returns edges', async () => {
    const r = await callRoute(ctx(), '/api/vaults/v/symbols/target/callers', 'GET');
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].toSymbol).toBe('target');
  });

  it('rejects missing q on symbols/by-name', async () => {
    const r = await callRoute(ctx(), '/api/vaults/v/symbols/by-name', 'GET');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid q/i);
  });

  it('GET /api/vaults/:id/notes/:path/backlinks returns wikilinks + callers', async () => {
    const r = await callRoute(ctx(), '/api/vaults/v/notes/n1.md/backlinks', 'GET');
    expect(r.body.wikilinks).toHaveLength(1);
    expect(r.body.wikilinks[0].target).toBe('n1.md');
    expect(r.body.callers).toHaveLength(0);
  });

  it('GET /api/vaults/:id/notes/:path/backlinks blocks unsafe paths', async () => {
    const r = await callRoute(ctx(), '/api/vaults/v/notes/../etc/passwd/backlinks', 'GET');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid/i);
  });

  it('POST /api/vaults/:id/symbols/:symbolId/summarize returns AI summary', async () => {
    const r = await callRoute(
      ctx({ llmProvider: fakeLLMProvider }),
      '/api/vaults/v/symbols/csharp::a.cs::Move/summarize',
      'POST',
    );
    expect(r.body.summary).toBe('Manages player movement.');
  });

  it('POST /api/vaults/:id/symbols/:symbolId/summarize returns 503 without LLM provider', async () => {
    const r = await callRoute(ctx(), '/api/vaults/v/symbols/csharp::a.cs::Move/summarize', 'POST');
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/LLM provider not available/);
  });
});
