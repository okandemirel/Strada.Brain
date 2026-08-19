/**
 * Vault ids are qualified; the names a caller knows are the kinds.
 *
 * Measured on the Pixel Flow run of 2026-08-19: vault_search's own description
 * offers 'self' as an example vaultId, the agent used it, and the registry
 * answered "vault not found: self" — twice. The registered id was
 * "self:strada-brain", and the error named no alternative to try.
 */

import { describe, it, expect } from 'vitest';
import { VaultRegistry } from './vault-registry.js';
import { vaultNotFound } from '../agents/tools/vault-not-found.js';
import type { IVault, VaultKind } from './vault.interface.js';

function vault(id: string, kind: VaultKind): IVault {
  return { id, kind, rootPath: `/roots/${id}` } as unknown as IVault;
}

describe('resolving the vault a caller meant', () => {
  it('accepts the kind when it names exactly one vault', () => {
    const registry = new VaultRegistry();
    registry.register(vault('self:strada-brain', 'self'));
    registry.register(vault('unity-project:pf', 'unity-project'));

    expect(registry.resolve('self')?.id).toBe('self:strada-brain');
  });

  it('accepts the kind even when the id is prefixed differently', () => {
    // The Unity project vault is registered as `unity:<hash>` with kind
    // 'unity-project' (stage-knowledge.ts) — the prefix and the kind are not
    // the same word, so neither rule covers the other.
    const registry = new VaultRegistry();
    registry.register(vault('unity:ab12cd34', 'unity-project'));

    expect(registry.resolve('unity-project')?.id).toBe('unity:ab12cd34');
    expect(registry.resolve('unity')?.id).toBe('unity:ab12cd34');
  });

  it('accepts an id prefix', () => {
    const registry = new VaultRegistry();
    registry.register(vault('obsidian:3f2a1b9c', 'obsidian'));

    expect(registry.resolve('obsidian')?.id).toBe('obsidian:3f2a1b9c');
  });

  it('keeps the exact id ahead of a kind that would also match', () => {
    const registry = new VaultRegistry();
    registry.register(vault('self', 'unity-project'));
    registry.register(vault('self:strada-brain', 'self'));

    expect(registry.resolve('self')?.id).toBe('self');
  });

  it('refuses to guess between two vaults of the same kind', () => {
    const registry = new VaultRegistry();
    registry.register(vault('knowledge:a', 'knowledge'));
    registry.register(vault('knowledge:b', 'knowledge'));

    expect(registry.resolve('knowledge')).toBeUndefined();
  });

  it('still misses when nothing resembles the request', () => {
    const registry = new VaultRegistry();
    registry.register(vault('self:strada-brain', 'self'));

    expect(registry.resolve('nonesuch')).toBeUndefined();
  });
});

describe('the miss the caller is told about', () => {
  it('names the ids that would have worked', () => {
    expect(vaultNotFound('self', ['self:strada-brain', 'unity-project:pf'])).toBe(
      'vault not found: self — registered: self:strada-brain, unity-project:pf',
    );
  });

  it('says so plainly when there is nothing to offer', () => {
    expect(vaultNotFound('self', [])).toBe('vault not found: self (none registered)');
  });
});
