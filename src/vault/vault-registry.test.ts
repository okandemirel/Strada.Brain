import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { VaultRegistry } from './vault-registry.js';
import { createFakeVault, createTempDirTracker } from '../test-helpers.js';
import type { VaultHit } from './vault.interface.js';

function makeHit(chunkId: string, rrf: number): VaultHit {
  return {
    chunk: { chunkId, path: 'notes/a.md', startLine: 1, endLine: 2, content: 'x', tokenCount: 1 },
    scores: { fts: null, hnsw: null, rrf },
  };
}

describe('VaultRegistry', () => {
  const tmp = createTempDirTracker('strada-registry-');

  function makeTempDir(prefix: string): string {
    // realpath immediately: macOS tmpdir lives behind a /var → /private/var
    // symlink and the registry canonicalizes via realpath.
    return realpathSync(tmp.makeDir(prefix));
  }

  afterEach(() => tmp.cleanup());

  it('supports register/get/list/unregister round-trips and onRegister listeners', () => {
    const registry = new VaultRegistry();
    const listener = vi.fn();
    const off = registry.onRegister(listener);

    const a = createFakeVault({ id: 'a', rootPath: '/tmp/vault-a' });
    registry.register(a);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(a);

    off();
    const b = createFakeVault({ id: 'b', rootPath: '/tmp/vault-b' });
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
    registry.register(createFakeVault({
      id: 'broken',
      rootPath: '/tmp/vault-broken',
      query: vi.fn(async () => { throw new Error('vault exploded'); }),
    }));
    const hit = makeHit('b1', 0.5);
    registry.register(createFakeVault({
      id: 'healthy',
      rootPath: '/tmp/vault-healthy',
      query: vi.fn(async () => ({ hits: [hit], budgetUsed: 1, truncated: false })),
    }));

    const result = await registry.query({ text: 'x' });

    expect(result.hits).toEqual([hit]);
    expect(result.truncated).toBe(false);
  });

  it('query() keeps the merged result within budgetTokens across vaults (MEM-14)', async () => {
    const registry = new VaultRegistry();
    const sized = (chunkId: string, rrf: number, tokenCount: number): VaultHit => {
      const hit = makeHit(chunkId, rrf);
      return { ...hit, chunk: { ...hit.chunk, tokenCount } };
    };
    // Each vault honoured the 4000-token budget on its own: 3000 tokens apiece.
    registry.register(createFakeVault({
      id: 'self',
      rootPath: '/tmp/vault-self',
      query: vi.fn(async () => ({ hits: [sized('s1', 0.9, 2000), sized('s2', 0.5, 1000)], budgetUsed: 3000, truncated: false })),
    }));
    registry.register(createFakeVault({
      id: 'project',
      rootPath: '/tmp/vault-project',
      query: vi.fn(async () => ({ hits: [sized('p1', 0.8, 1500), sized('p2', 0.4, 1500)], budgetUsed: 3000, truncated: false })),
    }));

    const result = await registry.query({ text: 'x', topK: 10, budgetTokens: 4000 });

    expect(result.budgetUsed).toBeLessThanOrEqual(4000);
    // Greedy in score order: s1 (2000) + p1 (1500) fit, s2 (1000) does not, p2 does not.
    expect(result.hits.map((h) => h.chunk.chunkId)).toEqual(['s1', 'p1']);
    expect(result.truncated).toBe(true);
  });

  it('resolveVaultForPath picks the longest matching root', () => {
    const root = makeTempDir('strada-registry-');
    const inner = join(root, 'inner');
    mkdirSync(inner);

    const registry = new VaultRegistry();
    const outerVault = createFakeVault({ id: 'outer', rootPath: root });
    const innerVault = createFakeVault({ id: 'inner', rootPath: inner });
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
      createVault: (rootPath) => createFakeVault({ id: 'created', rootPath }),
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
      createVault: (rootPath) => createFakeVault({ id: 'created', rootPath }),
      allowedRootPaths: [],
    });

    await expect(registry.createAndRegister(dir))
      .rejects.toThrow('vault root is outside the allowed project roots');
  });

  // MEM-7: every vault_init {rootPath} created (and registered over) a fresh
  // vault for the same root, orphaning the previous one's SQLite handle and
  // watcher where nothing could stop them.
  it('createAndRegister returns the vault already registered for that root', async () => {
    const allowed = makeTempDir('strada-registry-allowed-');
    const registry = new VaultRegistry();
    const createVault = vi.fn((rootPath: string) => createFakeVault({ id: 'generic:x', rootPath }));
    registry.setFactory({ createVault, allowedRootPaths: [allowed] });

    const first = await registry.createAndRegister(allowed);
    const second = await registry.createAndRegister(allowed);

    expect(second).toBe(first);
    expect(createVault).toHaveBeenCalledTimes(1);
    expect(first.dispose).not.toHaveBeenCalled();
  });

  it('register disposes a different instance it replaces under the same id', () => {
    const registry = new VaultRegistry();
    const older = createFakeVault({ id: 'same', rootPath: '/tmp/vault-same' });
    const newer = createFakeVault({ id: 'same', rootPath: '/tmp/vault-same' });
    registry.register(older);
    registry.register(older); // re-registering the same instance is not a replacement
    expect(older.dispose).not.toHaveBeenCalled();

    registry.register(newer);
    expect(older.dispose).toHaveBeenCalledTimes(1);
    expect(registry.get('same')).toBe(newer);
  });

  it('createAndRegister rejects when no factory is configured', async () => {
    const dir = makeTempDir('strada-registry-');
    const registry = new VaultRegistry();

    expect(registry.hasFactory()).toBe(false);
    await expect(registry.createAndRegister(dir)).rejects.toThrow('vault factory unavailable');
  });
});

describe('VaultRegistry disposal', () => {
  it('unregister disposes the vault instead of leaking its handles', async () => {
    // Only the dashboard DELETE route disposed explicitly; every other caller
    // silently leaked watcher fds and SQLite handles for process lifetime.
    const registry = new VaultRegistry();
    const vault = createFakeVault({ id: 'leaky', rootPath: '/tmp/vault-leaky' });
    registry.register(vault);

    registry.unregister('leaky');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(vault.dispose).toHaveBeenCalledTimes(1);
    expect(registry.get('leaky')).toBeUndefined();
  });

  it('disposeAll disposes every vault even when one dispose throws, and always clears state', async () => {
    // One throwing dispose used to abort the loop: every vault after it leaked
    // AND the map clears were skipped — the failure mode shutdown exists for.
    const registry = new VaultRegistry();
    const first = createFakeVault({ id: 'first', rootPath: '/tmp/v-d1' });
    const broken = createFakeVault({
      id: 'broken',
      rootPath: '/tmp/v-d2',
      dispose: vi.fn(async () => { throw new Error('dispose exploded'); }),
    });
    const last = createFakeVault({ id: 'last', rootPath: '/tmp/v-d3' });
    registry.register(first);
    registry.register(broken);
    registry.register(last);

    await expect(registry.disposeAll()).resolves.toBeUndefined();

    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(broken.dispose).toHaveBeenCalledTimes(1);
    expect(last.dispose).toHaveBeenCalledTimes(1);
    expect(registry.list()).toEqual([]);
    expect(registry.ids()).toEqual([]);
  });

  it('disposeAll takes each vault out of the registry before disposing it', async () => {
    // A vault's dispose waits for its background index to stop, and the boot
    // task that index belongs to starts watchers only while the vault is
    // still registered. Still listed at that moment, it started them anyway.
    const registry = new VaultRegistry();
    const seenDuringDispose: Array<unknown> = [];
    const vault = createFakeVault({
      id: 'indexing',
      rootPath: '/tmp/v-indexing',
      dispose: vi.fn(async () => { seenDuringDispose.push(registry.get('indexing')); }),
    });
    registry.register(vault);

    await registry.disposeAll();

    expect(vault.dispose).toHaveBeenCalledTimes(1);
    expect(seenDuringDispose).toEqual([undefined]);
  });
});

describe('resolve() accepts a bare id', () => {
  /**
   * Measured 2026-09-06: every vault_search an agent issued in the PixelFlow
   * campaign failed with "vault not found: 4ca9bd33 — registered:
   * unity:4ca9bd33, …" — the id copied from a log line without its kind
   * prefix. An id that is unambiguous without its prefix is not a wrong id.
   */
  it('resolves the hash without its kind prefix when it is unambiguous', () => {
    const registry = new VaultRegistry();
    registry.register(createFakeVault({ id: 'unity:4ca9bd33', rootPath: '/tmp/v-unity' }));
    registry.register(createFakeVault({ id: 'self:strada-brain', rootPath: '/tmp/v-self' }));
    expect(registry.resolve('4ca9bd33')?.id).toBe('unity:4ca9bd33');
  });

  it('refuses an ambiguous bare id rather than guessing', () => {
    const registry = new VaultRegistry();
    registry.register(createFakeVault({ id: 'unity:abc', rootPath: '/tmp/v1' }));
    registry.register(createFakeVault({ id: 'generic:abc', rootPath: '/tmp/v2' }));
    expect(registry.resolve('abc')).toBeUndefined();
    expect(registry.resolve('nope')).toBeUndefined();
  });
});
