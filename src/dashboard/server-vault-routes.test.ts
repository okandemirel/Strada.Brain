import { describe, it, expect } from 'vitest';
import { VaultRegistry } from '../vault/vault-registry.js';
import { registerVaultRoutes, type RouteApp } from './server-vault-routes.js';
import type { IVault } from '../vault/vault.interface.js';

/**
 * Minimal IVault stand-in. The GET /api/vaults handler only reads `id` + `kind`
 * (and goes through `registry.getName`), so the heavy IVault surface is unused.
 */
function fakeVault(id: string, kind: string): IVault {
  return { id, kind, rootPath: `/abs/secret/path/${id}` } as unknown as IVault;
}

type Handler = (req: unknown, res: unknown) => unknown;

function captureRoutes(registry: VaultRegistry) {
  const get = new Map<string, Handler>();
  const post = new Map<string, Handler>();
  const app: RouteApp = {
    get: (p, h) => { get.set(p, h as Handler); },
    post: (p, h) => { post.set(p, h as Handler); },
  };
  registerVaultRoutes(app, registry);
  return { get, post };
}

interface VaultListItem { id: string; kind: string; name: string }

describe('registerVaultRoutes GET /api/vaults — display name (H3)', () => {
  it('returns the name supplied at register() time', () => {
    const registry = new VaultRegistry();
    registry.register(fakeVault('generic:abc', 'unity-project'), 'My Project');
    const { get } = captureRoutes(registry);

    const result = get.get('/api/vaults')!(undefined, undefined) as { items: VaultListItem[] };

    expect(result.items).toEqual([
      { id: 'generic:abc', kind: 'unity-project', name: 'My Project' },
    ]);
  });

  it('falls back to a path-free, kind-derived label when no name was registered', () => {
    const registry = new VaultRegistry();
    registry.register(fakeVault('self:strada-brain', 'self'));
    registry.register(fakeVault('obsidian:def', 'obsidian'));
    registry.register(fakeVault('unity:ghi', 'unity-project'));
    const { get } = captureRoutes(registry);

    const result = get.get('/api/vaults')!(undefined, undefined) as { items: VaultListItem[] };
    const byId = Object.fromEntries(result.items.map((i) => [i.id, i.name]));

    expect(byId['self:strada-brain']).toBe('Strada.Brain (self)');
    expect(byId['obsidian:def']).toBe('Obsidian Vault');
    expect(byId['unity:ghi']).toBe('Unity Project');
    // SecC2 regression: the display name must never leak a filesystem path.
    for (const item of result.items) {
      expect(item.name).not.toContain('/abs/secret/path');
    }
  });

  it('drops the name once the vault is unregistered', () => {
    const registry = new VaultRegistry();
    registry.register(fakeVault('generic:abc', 'unity-project'), 'My Project');
    registry.unregister('generic:abc');

    expect(registry.getName('generic:abc')).toBeUndefined();
  });
});
