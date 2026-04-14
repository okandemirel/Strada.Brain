import { describe, it, expect, beforeEach } from 'vitest';
import { useVaultStore } from './vault-store.js';

describe('vault-store', () => {
  beforeEach(() => { useVaultStore.setState({ vaults: [], selected: null, searchResults: [] }); });

  it('setVaults replaces the list', () => {
    useVaultStore.getState().setVaults([{ id: 'a', kind: 'unity-project' }]);
    expect(useVaultStore.getState().vaults).toHaveLength(1);
  });
  it('select picks a vault', () => {
    useVaultStore.getState().setVaults([{ id: 'a', kind: 'unity-project' }]);
    useVaultStore.getState().select('a');
    expect(useVaultStore.getState().selected).toBe('a');
  });
  it('setSearchResults stores hits', () => {
    useVaultStore.getState().setSearchResults([{ chunk: { chunkId: 'c', path: 'a', startLine: 1, endLine: 1, content: '', tokenCount: 0 }, scores: { fts: 1, hnsw: null, rrf: 0.1 } }]);
    expect(useVaultStore.getState().searchResults).toHaveLength(1);
  });
});
