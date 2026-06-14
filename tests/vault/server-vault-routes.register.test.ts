import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { VaultRegistry } from '../../src/vault/vault-registry.js';
import {
  handleVaultRoutes,
  type VaultFactory,
} from '../../src/dashboard/server-vault-routes.js';
import type { RouteContext } from '../../src/dashboard/server-types.js';
import type { IVault } from '../../src/vault/vault.interface.js';

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

/** Minimal IVault stub — the POST path never calls init/startWatch synchronously. */
function makeStubVault(id: string, rootPath: string, kind: 'unity-project' | 'self' = 'unity-project'): IVault {
  let initCalled = false;
  return {
    id,
    rootPath,
    kind,
    init: async () => { initCalled = true; void initCalled; },
    sync: async () => ({ changed: 0, durationMs: 0 }),
    rebuild: async () => {},
    query: async () => ({ hits: [], budgetUsed: 0, truncated: false }),
    stats: async () => ({ fileCount: 0, chunkCount: 0, lastIndexedAt: null, dbBytes: 0 }),
    dispose: async () => {},
    listFiles: () => [],
    readFile: async () => '',
    onUpdate: () => () => {},
  };
}

describe('POST /api/vaults (register)', () => {
  let tmpDir: string;
  let registry: VaultRegistry;
  let factory: VaultFactory;
  let factoryCalls: Array<{ id: string; rootPath: string; kind: 'unity' | 'generic' }>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'vault-register-test-'));
    registry = new VaultRegistry();
    factoryCalls = [];
    factory = {
      watchDebounceMs: 800,
      async create(spec) {
        factoryCalls.push(spec);
        return makeStubVault(spec.id, spec.rootPath);
      },
    };
  });

  afterEach(async () => {
    for (const v of registry.list()) await v.dispose().catch(() => {});
    await rm(tmpDir, { recursive: true, force: true });
  });

  const ctxWithFactory = (): RouteContext =>
    ({ vaultRegistry: registry, vaultFactory: factory } as unknown as RouteContext);

  it('happy path: creates a vault when rootPath exists', async () => {
    const r = await callRoute(ctxWithFactory(), '/api/vaults', 'POST', {
      name: 'My Project', rootPath: tmpDir, kind: 'generic',
    });
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^generic:[a-f0-9]{8}$/);
    expect(r.body.status).toBe('indexing');
    expect(r.body.rootPath).toBeUndefined();
    expect(factoryCalls).toHaveLength(1);
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects invalid (non-existent) path', async () => {
    const r = await callRoute(ctxWithFactory(), '/api/vaults', 'POST', {
      name: 'X', rootPath: '/does/not/exist/abcdef123', kind: 'generic',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/path/i);
    expect(registry.list()).toHaveLength(0);
  });

  it('rejects relative path', async () => {
    const r = await callRoute(ctxWithFactory(), '/api/vaults', 'POST', {
      name: 'X', rootPath: './relative', kind: 'generic',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/absolute/i);
  });

  it('rejects invalid name', async () => {
    const r = await callRoute(ctxWithFactory(), '/api/vaults', 'POST', {
      name: 'bad<>name', rootPath: tmpDir, kind: 'generic',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/name/i);
  });

  it('rejects duplicate registration', async () => {
    const first = await callRoute(ctxWithFactory(), '/api/vaults', 'POST', {
      name: 'Proj', rootPath: tmpDir, kind: 'generic',
    });
    expect(first.body.id).toBeDefined();

    const second = await callRoute(ctxWithFactory(), '/api/vaults', 'POST', {
      name: 'Proj', rootPath: tmpDir, kind: 'generic',
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already/i);
  });

  it('responds with 503 message when no factory is wired', async () => {
    const r = await callRoute(
      { vaultRegistry: registry } as unknown as RouteContext, // no vaultFactory
      '/api/vaults',
      'POST',
      { name: 'Proj', rootPath: tmpDir, kind: 'generic' },
    );
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/VaultFactory not installed/i);
  });
});
