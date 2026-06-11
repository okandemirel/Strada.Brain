import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VaultRegistry } from './vault-registry.js';
import type { IVault, VaultHit } from './vault.interface.js';

function makeFakeVault(id: string, rootPath: string, overrides: Partial<IVault> = {}): IVault {
  return {
    id,
    kind: 'unity-project',
    rootPath,
    init: vi.fn(async () => undefined),
    sync: vi.fn(async () => ({ changed: 0, durationMs: 0 })),
    rebuild: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ hits: [], budgetUsed: 0, truncated: false })),
    stats: vi.fn(async () => ({ fileCount: 0, chunkCount: 0, lastIndexedAt: null, dbBytes: 0 })),
    dispose: vi.fn(async () => undefined),
    listFiles: vi.fn(() => []),
    readFile: vi.fn(async () => ''),
    onUpdate: vi.fn(() => () => undefined),
    ...overrides,
  };
}

function makeHit(chunkId: string, rrf: number): VaultHit {
  return {
    chunk: { chunkId, path: 'notes/a.md', startLine: 1, endLine: 2, content: 'x', tokenCount: 1 },
    scores: { fts: null, hnsw: null, rrf },
  };
}

describe('VaultRegistry', () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    // realpath immediately: macOS tmpdir lives behind a /var → /private/var
    // symlink and the registry canonicalizes via realpath.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supports register/get/list/unregister round-trips and onRegister listeners', () => {
    const registry = new VaultRegistry();
    const listener = vi.fn();
    const off = registry.onRegister(listener);

    const a = makeFakeVault('a', '/tmp/vault-a');
    registry.register(a);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(a);

    off();
    const b = makeFakeVault('b', '/tmp/vault-b');
    registry.register(b);
    expect(listener).toHaveBeenCalledTimes(1);

    expect(registry.get('a')).toBe(a);
    expect(registry.list()).toEqual([a, b]);

    registry.unregister('a');
    expect(registry.get('a')).toBeUndefined();
    expect(registry.list()).toEqual([b]);
  });

  it('query() survives a vault whose query rejects', async () => {
    const registry = new VaultRegistry();
    registry.register(makeFakeVault('broken', '/tmp/vault-broken', {
      query: vi.fn(async () => { throw new Error('vault exploded'); }),
    }));
    const hit = makeHit('b1', 0.5);
    registry.register(makeFakeVault('healthy', '/tmp/vault-healthy', {
      query: vi.fn(async () => ({ hits: [hit], budgetUsed: 1, truncated: false })),
    }));

    const result = await registry.query({ text: 'x' });

    expect(result.hits).toEqual([hit]);
    expect(result.truncated).toBe(false);
  });

  it('resolveVaultForPath picks the longest matching root', () => {
    const root = makeTempDir('strada-registry-');
    const inner = join(root, 'inner');
    mkdirSync(inner);

    const registry = new VaultRegistry();
    const outerVault = makeFakeVault('outer', root);
    const innerVault = makeFakeVault('inner', inner);
    registry.register(outerVault);
    registry.register(innerVault);

    expect(registry.resolveVaultForPath(join(inner, 'note.md'))).toBe(innerVault);
    expect(registry.resolveVaultForPath(join(root, 'other.md'))).toBe(outerVault);
    expect(registry.resolveVaultForPath('/definitely/unrelated/path.md')).toBeUndefined();
  });

  it('createAndRegister enforces the factory allow-list', async () => {
    const allowed = makeTempDir('strada-registry-allowed-');
    const project = join(allowed, 'proj');
    mkdirSync(project);
    const outside = makeTempDir('strada-registry-outside-');

    const registry = new VaultRegistry();
    registry.setFactory({
      createVault: (rootPath) => makeFakeVault('created', rootPath),
      allowedRootPaths: [allowed],
    });

    const vault = await registry.createAndRegister(project);
    expect(vault.rootPath).toBe(project);
    expect(registry.list()).toContain(vault);

    await expect(registry.createAndRegister(outside))
      .rejects.toThrow('vault root is outside the allowed project roots');
  });

  it('createAndRegister rejects everything when the allow-list is empty', async () => {
    const dir = makeTempDir('strada-registry-');
    const registry = new VaultRegistry();
    registry.setFactory({
      createVault: (rootPath) => makeFakeVault('created', rootPath),
      allowedRootPaths: [],
    });

    await expect(registry.createAndRegister(dir))
      .rejects.toThrow('vault root is outside the allowed project roots');
  });

  it('createAndRegister rejects when no factory is configured', async () => {
    const dir = makeTempDir('strada-registry-');
    const registry = new VaultRegistry();

    expect(registry.hasFactory()).toBe(false);
    await expect(registry.createAndRegister(dir)).rejects.toThrow('vault factory unavailable');
  });
});
