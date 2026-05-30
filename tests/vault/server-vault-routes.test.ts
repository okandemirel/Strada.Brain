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
const reg = { list: () => [fakeVault], get: (id: string) => id === 'unity:abc' ? fakeVault : undefined, getName: () => undefined } as any;

describe('vault routes', () => {
  it('GET /api/vaults lists vaults (without rootPath)', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as any, reg);
    const r = await app.routes['GET /api/vaults']({}, {});
    // H3: a display name is included; with no registered name it falls back to a
    // path-free kind label.
    expect(r.items[0]).toMatchObject({ id: 'unity:abc', kind: 'unity-project', name: 'Unity Project' });
    // SecC2: rootPath MUST NOT leak to clients
    expect(r.items[0]).not.toHaveProperty('rootPath');
  });

  it('POST /search rejects non-string text', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as any, reg);
    const r = await app.routes['POST /api/vaults/:id/search']({ params: { id: 'unity:abc' }, body: { text: 123 } }, {});
    expect(r.error).toMatch(/invalid text/i);
  });

  it('POST /search caps topK at 100', async () => {
    const app = makeFakeApp();
    const recorded: any[] = [];
    const vault = { ...fakeVault, query: async (q: any) => { recorded.push(q); return { hits: [], budgetUsed: 0, truncated: false }; } };
    const localReg = { get: () => vault } as any;
    registerVaultRoutes(app as any, localReg);
    await app.routes['POST /api/vaults/:id/search']({ params: { id: 'unity:abc' }, body: { text: 'x', topK: 9999 } }, {});
    expect(recorded[0].topK).toBeLessThanOrEqual(100);
  });

  it('POST /search forwards documented filters', async () => {
    const app = makeFakeApp();
    const recorded: any[] = [];
    const vault = { ...fakeVault, query: async (q: any) => { recorded.push(q); return { hits: [], budgetUsed: 0, truncated: false }; } };
    const localReg = { get: () => vault } as any;
    registerVaultRoutes(app as any, localReg);
    await app.routes['POST /api/vaults/:id/search']({
      params: { id: 'unity:abc' },
      body: {
        text: 'needle',
        topK: 5,
        budgetTokens: 1000,
        langFilter: ['typescript'],
        pathGlob: 'src/**/*.ts',
        focusFiles: ['src/a.ts'],
      },
    }, {});
    expect(recorded[0]).toEqual({
      text: 'needle',
      topK: 5,
      budgetTokens: 1000,
      langFilter: ['typescript'],
      pathGlob: 'src/**/*.ts',
      focusFiles: ['src/a.ts'],
    });
  });

  it('file: URL-encoded traversal blocked', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as any, reg);
    const r = await app.routes['GET /api/vaults/:id/file']({ params: { id: 'unity:abc' }, query: { path: '%2e%2e/etc' } }, {});
    expect(r.error).toMatch(/invalid/i);
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

  it('file route truncates the body to maxChars when provided', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as any, reg);
    const r = await app.routes['GET /api/vaults/:id/file']({ params: { id: 'unity:abc' }, query: { path: 'a.cs', maxChars: '2' } }, {});
    expect(r.body).toBe('AL'); // 'ALPHA' truncated to 2 chars
  });

  it('file route returns the full body when maxChars is absent or invalid', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as any, reg);
    const full = await app.routes['GET /api/vaults/:id/file']({ params: { id: 'unity:abc' }, query: { path: 'a.cs' } }, {});
    expect(full.body).toBe('ALPHA');
    const bad = await app.routes['GET /api/vaults/:id/file']({ params: { id: 'unity:abc' }, query: { path: 'a.cs', maxChars: '-1' } }, {});
    expect(bad.body).toBe('ALPHA');
  });
});
