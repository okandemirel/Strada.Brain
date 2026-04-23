import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultRegistry } from '../../src/vault/vault-registry.js';
import {
  registerVaultRoutes,
  type VaultFactory,
} from '../../src/dashboard/server-vault-routes.js';
import type { IVault } from '../../src/vault/vault.interface.js';

function makeFakeApp() {
  const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
  return {
    get: (p: string, h: (req: unknown, res: unknown) => unknown) => { routes['GET ' + p] = h; },
    post: (p: string, h: (req: unknown, res: unknown) => unknown) => { routes['POST ' + p] = h; },
    routes,
  };
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

  it('happy path: creates a vault when rootPath exists', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as never, registry, factory);
    const resp = (await app.routes['POST /api/vaults']({
      body: { name: 'My Project', rootPath: tmpDir, kind: 'generic' },
    }, {})) as { id?: string; status?: string; error?: string; kind?: string };
    expect(resp.error).toBeUndefined();
    expect(resp.id).toMatch(/^generic:[a-f0-9]{8}$/);
    expect(resp.status).toBe('indexing');
    expect(factoryCalls).toHaveLength(1);
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects invalid (non-existent) path', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as never, registry, factory);
    const resp = (await app.routes['POST /api/vaults']({
      body: { name: 'X', rootPath: '/does/not/exist/abcdef123', kind: 'generic' },
    }, {})) as { error?: string };
    expect(resp.error).toMatch(/path/i);
    expect(registry.list()).toHaveLength(0);
  });

  it('rejects relative path', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as never, registry, factory);
    const resp = (await app.routes['POST /api/vaults']({
      body: { name: 'X', rootPath: './relative', kind: 'generic' },
    }, {})) as { error?: string };
    expect(resp.error).toMatch(/absolute/i);
  });

  it('rejects invalid name', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as never, registry, factory);
    const resp = (await app.routes['POST /api/vaults']({
      body: { name: 'bad<>name', rootPath: tmpDir, kind: 'generic' },
    }, {})) as { error?: string };
    expect(resp.error).toMatch(/name/i);
  });

  it('rejects duplicate registration', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as never, registry, factory);
    const first = (await app.routes['POST /api/vaults']({
      body: { name: 'Proj', rootPath: tmpDir, kind: 'generic' },
    }, {})) as { id?: string };
    expect(first.id).toBeDefined();

    const second = (await app.routes['POST /api/vaults']({
      body: { name: 'Proj', rootPath: tmpDir, kind: 'generic' },
    }, {})) as { error?: string };
    expect(second.error).toMatch(/already/i);
  });

  it('responds with 503 message when no factory is wired', async () => {
    const app = makeFakeApp();
    registerVaultRoutes(app as never, registry); // no factory
    const resp = (await app.routes['POST /api/vaults']({
      body: { name: 'Proj', rootPath: tmpDir, kind: 'generic' },
    }, {})) as { error?: string };
    expect(resp.error).toMatch(/unavailable/i);
  });
});

