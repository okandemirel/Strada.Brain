import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { handleVaultRoutes } from '../../src/dashboard/server-vault-routes.js';
import { VaultRegistry } from '../../src/vault/vault-registry.js';
import type { RouteContext } from '../../src/dashboard/server-types.js';
import type { IVault } from '../../src/vault/vault.interface.js';

/**
 * Drives the production raw-http `handleVaultRoutes` with a mock
 * IncomingMessage/ServerResponse, capturing the JSON status + body. Replaces the
 * old `registerVaultRoutes` (Express dev/test adapter) tests now that the dead
 * adapter has been removed.
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
      writeHead(status: number) { captured.status = status; return res; },
      end(s?: string) {
        if (typeof s === 'string') { try { captured.body = JSON.parse(s); } catch { captured.body = s; } }
        resolve(captured);
      },
    };
    const req = Readable.from(body !== undefined ? [Buffer.from(JSON.stringify(body))] : []);
    const handled = handleVaultRoutes(url, method, req as never, res as never, ctx);
    if (!handled) resolve({ status: 0, body: { __unhandled: true } });
  });
}

const fakeVault = {
  id: 'unity:abc', kind: 'unity-project', rootPath: '/proj',
  stats: async () => ({ fileCount: 2, chunkCount: 5, lastIndexedAt: 0, dbBytes: 128 }),
  listFiles: () => [{ path: 'a.cs', lang: 'csharp' }, { path: 'b.md', lang: 'markdown' }],
  readFile: async (p: string) => (p === 'a.cs' ? 'ALPHA' : 'BETA'),
  query: async () => ({ hits: [{ chunk: { chunkId: 'c', path: 'a.cs', startLine: 1, endLine: 1, content: 'x', tokenCount: 1 }, scores: { fts: 1, hnsw: 0.9, rrf: 0.1 } }], budgetUsed: 1, truncated: false }),
  sync: async () => ({ changed: 2, durationMs: 50 }),
};

function ctxFor(reg: unknown): RouteContext {
  return { vaultRegistry: reg } as unknown as RouteContext;
}

const reg = {
  list: () => [fakeVault],
  get: (id: string) => (id === 'unity:abc' ? fakeVault : undefined),
  getName: () => undefined,
};

describe('handleVaultRoutes', () => {
  it('GET /api/vaults lists vaults with a name and without rootPath', async () => {
    const r = await callRoute(ctxFor(reg), '/api/vaults', 'GET');
    expect(r.status).toBe(200);
    // H3: a display name is included; with no registered name it falls back to a
    // path-free kind label.
    expect(r.body.items[0]).toMatchObject({ id: 'unity:abc', kind: 'unity-project', name: 'Unity Project' });
    // SecC2: rootPath MUST NOT leak to clients.
    expect(r.body.items[0]).not.toHaveProperty('rootPath');
  });

  it('GET /api/vaults returns the registered name when one exists', async () => {
    const named = { ...reg, getName: () => 'My Project' };
    const r = await callRoute(ctxFor(named), '/api/vaults', 'GET');
    expect(r.body.items[0]).toMatchObject({ id: 'unity:abc', name: 'My Project' });
  });

  it('GET /api/vaults falls back to a path-free kind label per kind', async () => {
    const registry = new VaultRegistry();
    registry.register({ id: 'self:x', kind: 'self', rootPath: '/abs/secret/self' } as unknown as IVault);
    registry.register({ id: 'obs:y', kind: 'obsidian', rootPath: '/abs/secret/obs' } as unknown as IVault);
    const r = await callRoute(ctxFor(registry), '/api/vaults', 'GET');
    const byId = Object.fromEntries(r.body.items.map((i: { id: string; name: string }) => [i.id, i.name]));
    expect(byId['self:x']).toBe('Strada.Brain (self)');
    expect(byId['obs:y']).toBe('Obsidian Vault');
    for (const i of r.body.items) expect(i.name).not.toContain('/abs/secret');
  });

  it('GET /api/vaults/:id/tree returns the file list', async () => {
    const r = await callRoute(ctxFor(reg), '/api/vaults/unity:abc/tree', 'GET');
    expect(r.body.items).toHaveLength(2);
  });

  it('GET /api/vaults/:id/file returns the body', async () => {
    const r = await callRoute(ctxFor(reg), '/api/vaults/unity:abc/file?path=b.md', 'GET');
    expect(r.body.body).toBe('BETA');
  });

  it('GET file truncates the body to maxChars when provided', async () => {
    const r = await callRoute(ctxFor(reg), '/api/vaults/unity:abc/file?path=a.cs&maxChars=2', 'GET');
    expect(r.body.body).toBe('AL'); // 'ALPHA' → 2 chars
  });

  it('GET file returns the full body when maxChars is absent or invalid', async () => {
    const full = await callRoute(ctxFor(reg), '/api/vaults/unity:abc/file?path=a.cs', 'GET');
    expect(full.body.body).toBe('ALPHA');
    const bad = await callRoute(ctxFor(reg), '/api/vaults/unity:abc/file?path=a.cs&maxChars=-1', 'GET');
    expect(bad.body.body).toBe('ALPHA');
  });

  it('GET file blocks path traversal (plain and URL-encoded) with 400', async () => {
    const plain = await callRoute(ctxFor(reg), '/api/vaults/unity:abc/file?path=../etc/passwd', 'GET');
    expect(plain.status).toBe(400);
    expect(plain.body.error).toMatch(/invalid/i);
    const encoded = await callRoute(ctxFor(reg), '/api/vaults/unity:abc/file?path=%2e%2e/etc', 'GET');
    expect(encoded.status).toBe(400);
    expect(encoded.body.error).toMatch(/invalid/i);
  });

  it('POST /api/vaults/:id/search returns hits', async () => {
    const r = await callRoute(ctxFor(reg), '/api/vaults/unity:abc/search', 'POST', { text: 'x' });
    expect(r.body.hits).toHaveLength(1);
  });

  it('POST /search rejects non-string text with 400', async () => {
    const r = await callRoute(ctxFor(reg), '/api/vaults/unity:abc/search', 'POST', { text: 123 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid text/i);
  });

  it('POST /search caps topK at 100 and forwards documented filters', async () => {
    const recorded: any[] = [];
    const recordingVault = { ...fakeVault, query: async (q: any) => { recorded.push(q); return { hits: [], budgetUsed: 0, truncated: false }; } };
    const recReg = { ...reg, get: () => recordingVault };

    await callRoute(ctxFor(recReg), '/api/vaults/unity:abc/search', 'POST', { text: 'x', topK: 9999 });
    expect(recorded[0].topK).toBeLessThanOrEqual(100);

    recorded.length = 0;
    await callRoute(ctxFor(recReg), '/api/vaults/unity:abc/search', 'POST', {
      text: 'needle', topK: 5, budgetTokens: 1000,
      langFilter: ['typescript'], pathGlob: 'src/**/*.ts', focusFiles: ['src/a.ts'],
    });
    expect(recorded[0]).toEqual({
      text: 'needle', topK: 5, budgetTokens: 1000,
      langFilter: ['typescript'], pathGlob: 'src/**/*.ts', focusFiles: ['src/a.ts'],
    });
  });

  it('POST /api/vaults/:id/sync returns the change summary', async () => {
    const r = await callRoute(ctxFor(reg), '/api/vaults/unity:abc/sync', 'POST');
    expect(r.body.changed).toBe(2);
  });

  it('returns 404 for an unknown vault id', async () => {
    const r = await callRoute(ctxFor(reg), '/api/vaults/nope/tree', 'GET');
    expect(r.status).toBe(404);
  });
});

describe('VaultRegistry display name', () => {
  it('drops the registered name when the vault is unregistered', () => {
    const registry = new VaultRegistry();
    registry.register({
      id: 'generic:abc', kind: 'unity-project', rootPath: '/x',
      // unregister() best-effort disposes the vault; the fake must satisfy that.
      dispose: async () => {},
    } as unknown as IVault, 'My Project');
    expect(registry.getName('generic:abc')).toBe('My Project');
    registry.unregister('generic:abc');
    expect(registry.getName('generic:abc')).toBeUndefined();
  });
});
