import { describe, it, expect, beforeEach } from 'vitest';
import { useVaultStore, ALL_SYMBOL_KINDS } from './vault-store.js';

function resetFullStore() {
  useVaultStore.setState({
    vaults: [],
    selected: null,
    searchResults: [],
    graphCache: {},
    selectedSymbolId: null,
    activeFilePath: null,
    leftPanelOpen: true,
    rightPanelOpen: true,
    activeTab: 'files',
    activeRightTab: 'backlinks',
    commandPaletteOpen: false,
    recentFiles: [],
    recentSymbols: [],
  });
  useVaultStore.getState().resetGraphFilters();
}

describe('vault-store', () => {
  beforeEach(resetFullStore);

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

describe('vault-store — graph state', () => {
  beforeEach(resetFullStore);

  it('initializes with all symbol kinds enabled and empty filters', () => {
    const { graphFilters } = useVaultStore.getState();
    for (const k of ALL_SYMBOL_KINDS) expect(graphFilters.kinds[k]).toBe(true);
    expect(graphFilters.search).toBe('');
    expect(graphFilters.fileFilter).toBe('');
  });

  it('toggleGraphKind flips a single kind without touching others', () => {
    useVaultStore.getState().toggleGraphKind('class');
    const s = useVaultStore.getState();
    expect(s.graphFilters.kinds.class).toBe(false);
    expect(s.graphFilters.kinds.method).toBe(true);
  });

  it('setGraphSearch / setGraphFileFilter preserve the other filter', () => {
    const api = useVaultStore.getState();
    api.setGraphSearch('foo');
    api.setGraphFileFilter('src/');
    const s = useVaultStore.getState();
    expect(s.graphFilters.search).toBe('foo');
    expect(s.graphFilters.fileFilter).toBe('src/');
  });

  it('resetGraphFilters restores defaults', () => {
    const api = useVaultStore.getState();
    api.setGraphSearch('foo');
    api.toggleGraphKind('class');
    api.resetGraphFilters();
    const { graphFilters } = useVaultStore.getState();
    expect(graphFilters.search).toBe('');
    expect(graphFilters.kinds.class).toBe(true);
  });

  it('setGraph enforces an LRU cap and drops the oldest vault first', () => {
    const api = useVaultStore.getState();
    // Cap is 5 (see constants.GRAPH_CACHE_MAX_VAULTS). Insert 6 vaults and
    // assert the first one was evicted.
    for (let i = 1; i <= 6; i++) {
      api.setGraph(`v${i}`, { nodes: [], edges: [] });
    }
    const { graphCache } = useVaultStore.getState();
    expect(Object.keys(graphCache)).toHaveLength(5);
    expect(graphCache['v1']).toBeUndefined();
    expect(graphCache['v6']).toBeDefined();
  });

  it('setGraph bumps an existing vault to most-recently-used', () => {
    const api = useVaultStore.getState();
    for (let i = 1; i <= 5; i++) api.setGraph(`v${i}`, { nodes: [], edges: [] });
    // Touch v1 so it becomes the newest entry, then push a 6th — v2 (now oldest) drops.
    api.setGraph('v1', { nodes: [], edges: [] });
    api.setGraph('v6', { nodes: [], edges: [] });
    const { graphCache } = useVaultStore.getState();
    expect(graphCache['v1']).toBeDefined();
    expect(graphCache['v2']).toBeUndefined();
  });

  it('selecting a vault clears any stale symbol selection', () => {
    useVaultStore.setState({ selectedSymbolId: 'stale-id' });
    useVaultStore.getState().select('vault-a');
    expect(useVaultStore.getState().selectedSymbolId).toBeNull();
    expect(useVaultStore.getState().selected).toBe('vault-a');
  });

  it('setSelectedSymbol accepts null to clear', () => {
    useVaultStore.getState().setSelectedSymbol('sym-1');
    expect(useVaultStore.getState().selectedSymbolId).toBe('sym-1');
    useVaultStore.getState().setSelectedSymbol(null);
    expect(useVaultStore.getState().selectedSymbolId).toBeNull();
  });
});

describe('vault-store — layout state', () => {
  beforeEach(resetFullStore);

  it('toggleLeftPanel flips leftPanelOpen', () => {
    const api = useVaultStore.getState();
    expect(useVaultStore.getState().leftPanelOpen).toBe(true);
    api.toggleLeftPanel();
    expect(useVaultStore.getState().leftPanelOpen).toBe(false);
  });

  it('setActiveTab updates activeTab', () => {
    useVaultStore.getState().setActiveTab('graph');
    expect(useVaultStore.getState().activeTab).toBe('graph');
  });

  it('setActiveFilePath pushes into recentFiles (newest first, unique)', () => {
    const api = useVaultStore.getState();
    api.setActiveFilePath('a.ts');
    api.setActiveFilePath('b.ts');
    api.setActiveFilePath('a.ts');
    expect(useVaultStore.getState().recentFiles).toEqual(['a.ts', 'b.ts']);
  });

  it('setSelectedSymbol feeds recentSymbols', () => {
    const api = useVaultStore.getState();
    api.setSelectedSymbol('sym-A');
    api.setSelectedSymbol('sym-B');
    expect(useVaultStore.getState().recentSymbols).toEqual(['sym-B', 'sym-A']);
  });

  it('toggleCommandPalette flips commandPaletteOpen', () => {
    const api = useVaultStore.getState();
    api.toggleCommandPalette();
    expect(useVaultStore.getState().commandPaletteOpen).toBe(true);
    api.toggleCommandPalette();
    expect(useVaultStore.getState().commandPaletteOpen).toBe(false);
  });
});
