import { describe, it, expect } from 'vitest';
import { registerVaultRoutes } from '../../src/dashboard/server-vault-routes.js';

function makeFakeApp() {
  const routes: Record<string, (req: any, res: any) => any> = {};
  return {
    get: (p: string, h: (req: any, res: any) => any) => { routes['GET ' + p] = h; },
    post: (p: string, h: (req: any, res: any) => any) => { routes['POST ' + p] = h; },
    routes,
  };
}

const canvas = {
  nodes: [{ id: 'a', type: 'text', text: '**class** Foo', x: 0, y: 0, width: 100, height: 60, file: 'a.ts' }],
  edges: [],
};

const fakeVault = {
  id: 'v', kind: 'unity-project', rootPath: '/tmp',
  readCanvas: async () => canvas,
  findCallers: async (id: string) =>
    id === 'missing'
      ? []
      : [{ fromSymbol: 'csharp::a.cs::Caller', toSymbol: id, kind: 'calls' as const, atLine: 7 }],
  findSymbolsByName: async (name: string) =>
    name === 'Move'
      ? [{ symbolId: 'x', name: 'Move', path: 'a.cs', kind: 'method', display: 'Move', startLine: 1, endLine: 1, doc: null }]
      : [],
  stats: async () => ({ fileCount: 0, chunkCount: 0, lastIndexedAt: null, dbBytes: 0 }),
  listFiles: () => [],
  readFile: async () => '',
  query: async () => ({ hits: [], budgetUsed: 0, truncated: false }),
  sync: async () => ({ changed: 0, durationMs: 0 }),
};

const reg = {
  list: () => [fakeVault],
  get: (id: string) => id === 'v' ? fakeVault : undefined,
} as never;

describe('vault routes — graph endpoints', () => {
  it('GET /api/vaults/:id/canvas returns the canvas JSON', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as never, reg);
    const r = await app.routes['GET /api/vaults/:id/canvas']!({ params: { id: 'v' } }, {});
    expect(r).toEqual(canvas);
  });

  it('GET /api/vaults/:id/symbols/by-name returns matches', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as never, reg);
    const r = await app.routes['GET /api/vaults/:id/symbols/by-name']!({ params: { id: 'v' }, query: { q: 'Move' } }, {});
    expect(r.items).toHaveLength(1);
    expect(r.items[0].name).toBe('Move');
  });

  it('GET /api/vaults/:id/symbols/:symbolId/callers returns edges', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as never, reg);
    const r = await app.routes['GET /api/vaults/:id/symbols/:symbolId/callers']!({ params: { id: 'v', symbolId: 'target' } }, {});
    expect(r.items).toHaveLength(1);
    expect(r.items[0].toSymbol).toBe('target');
  });

  it('rejects missing q on symbols/by-name', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as never, reg);
    const r = await app.routes['GET /api/vaults/:id/symbols/by-name']!({ params: { id: 'v' }, query: {} }, {});
    expect(r.error).toMatch(/invalid q/i);
  });
});
