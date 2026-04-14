import { describe, it, expect } from 'vitest';
import { registerVaultRoutes } from '../../src/dashboard/server-vault-routes.js';

function makeFakeApp() {
  const routes: Record<string, any> = {};
  return {
    get: (p: string, h: any) => { routes['GET ' + p] = h; },
    post: (p: string, h: any) => { routes['POST ' + p] = h; },
    routes,
  };
}

const fakeVault = {
  id: 'unity:abc', kind: 'unity-project', rootPath: '/proj',
  stats: async () => ({ fileCount: 2, chunkCount: 5, lastIndexedAt: 0, dbBytes: 128 }),
  listFiles: () => [{ path: 'a.cs', lang: 'csharp' }, { path: 'b.md', lang: 'markdown' }],
  readFile: async (p: string) => p === 'a.cs' ? 'ALPHA' : 'BETA',
  query: async () => ({ hits: [{ chunk: { chunkId: 'c', path: 'a.cs', startLine: 1, endLine: 1, content: 'x', tokenCount: 1 }, scores: { fts: 1, hnsw: 0.9, rrf: 0.1 } }], budgetUsed: 1, truncated: false }),
  sync: async () => ({ changed: 2, durationMs: 50 }),
};
const reg = { list: () => [fakeVault], get: (id: string) => id === 'unity:abc' ? fakeVault : undefined } as any;

describe('vault routes', () => {
  it('GET /api/vaults lists vaults', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as any, reg);
    const r = await app.routes['GET /api/vaults']({}, {});
    expect(r.items[0]).toMatchObject({ id: 'unity:abc', kind: 'unity-project' });
  });

  it('GET /api/vaults/:id/tree returns files', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as any, reg);
    const r = await app.routes['GET /api/vaults/:id/tree']({ params: { id: 'unity:abc' } }, {});
    expect(r.items).toHaveLength(2);
  });

  it('GET /api/vaults/:id/file returns body', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as any, reg);
    const r = await app.routes['GET /api/vaults/:id/file']({ params: { id: 'unity:abc' }, query: { path: 'b.md' } }, {});
    expect(r.body).toBe('BETA');
  });

  it('POST /api/vaults/:id/search returns hits', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as any, reg);
    const r = await app.routes['POST /api/vaults/:id/search']({ params: { id: 'unity:abc' }, body: { text: 'x' } }, {});
    expect(r.hits).toHaveLength(1);
  });

  it('POST /api/vaults/:id/sync returns summary', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as any, reg);
    const r = await app.routes['POST /api/vaults/:id/sync']({ params: { id: 'unity:abc' } }, {});
    expect(r.changed).toBe(2);
  });

  it('file path traversal blocked', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as any, reg);
    const r = await app.routes['GET /api/vaults/:id/file']({ params: { id: 'unity:abc' }, query: { path: '../etc/passwd' } }, {});
    expect(r.error).toMatch(/invalid/i);
  });
});
