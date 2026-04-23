import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { MAX_RECENT, GRAPH_CACHE_MAX_VAULTS } from '../pages/vaults/constants';
import { createSafeJSONStorage } from './persist-storage';

export interface VaultSummary { id: string; kind: string; }
export interface SearchHit {
  chunk: { chunkId: string; path: string; startLine: number; endLine: number; content: string; tokenCount: number };
  scores: { fts: number | null; hnsw: number | null; rrf: number };
}

export interface CanvasNode {
  id: string; type: 'text'; text: string;
  x: number; y: number; width: number; height: number;
  color?: string; file?: string; kind?: string;
}
export interface CanvasEdge { id: string; fromNode: string; toNode: string; label?: string; }
export interface CanvasJson { nodes: CanvasNode[]; edges: CanvasEdge[]; }

// Mirrors backend src/vault/vault.interface.ts `SymbolKind`.
export type SymbolKind =
  | 'class'
  | 'method'
  | 'field'
  | 'namespace'
  | 'function'
  | 'interface'
  | 'note';

export const ALL_SYMBOL_KINDS: readonly SymbolKind[] = [
  'class', 'method', 'field', 'namespace', 'function', 'interface', 'note',
] as const;

export interface GraphFilters {
  /** Per-kind visibility toggle. */
  kinds: Record<SymbolKind, boolean>;
  /** Case-insensitive substring match on node label. Empty string = no search filter. */
  search: string;
  /** Substring on CanvasNode.file. Empty string = all files. */
  fileFilter: string;
}

/** Active tab within the Vault center panel. */
export type VaultTab = 'files' | 'search' | 'graph' | 'bookmarks';

/** Active right-panel section. */
export type RightPanelTab = 'backlinks' | 'outline' | 'metadata';

/** Persisted UI layout slice (panel widths/visibility + recent items). */
export interface VaultLayoutState {
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  activeTab: VaultTab;
  activeRightTab: RightPanelTab;
  /** Most recently visited file paths, newest first, capped at 10. */
  recentFiles: string[];
  /** Most recently visited symbol ids, newest first, capped at 10. */
  recentSymbols: string[];
}

function defaultFilters(): GraphFilters {
  const kinds = Object.fromEntries(ALL_SYMBOL_KINDS.map((k) => [k, true])) as Record<SymbolKind, boolean>;
  return { kinds, search: '', fileFilter: '' };
}

interface VaultState extends VaultLayoutState {
  vaults: VaultSummary[];
  selected: string | null;
  searchResults: SearchHit[];
  graphCache: Record<string, CanvasJson | null>;

  /** Node id of the symbol selected in the graph detail panel. */
  selectedSymbolId: string | null;
  /** Currently open file path (for file tab center view). */
  activeFilePath: string | null;
  /** Graph view filters (kinds / search / file). */
  graphFilters: GraphFilters;

  /** Command palette visibility (not persisted). */
  commandPaletteOpen: boolean;

  setVaults(v: VaultSummary[]): void;
  select(id: string): void;
  setSearchResults(r: SearchHit[]): void;
  setGraph(id: string, g: CanvasJson | null): void;
  /** Remove a vault's canvas cache entry (back to "not-fetched" state). */
  clearGraph(id: string): void;
  setSelectedSymbol(id: string | null): void;
  setActiveFilePath(path: string | null): void;
  setGraphSearch(value: string): void;
  setGraphFileFilter(value: string): void;
  toggleGraphKind(kind: SymbolKind): void;
  resetGraphFilters(): void;

  setActiveTab(tab: VaultTab): void;
  setActiveRightTab(tab: RightPanelTab): void;
  toggleLeftPanel(): void;
  toggleRightPanel(): void;
  setLeftPanelOpen(open: boolean): void;
  setRightPanelOpen(open: boolean): void;

  setCommandPaletteOpen(open: boolean): void;
  toggleCommandPalette(): void;
}

const DEFAULT_LAYOUT: VaultLayoutState = {
  leftPanelOpen: true,
  rightPanelOpen: true,
  activeTab: 'files',
  activeRightTab: 'backlinks',
  recentFiles: [],
  recentSymbols: [],
};

function pushUnique(list: string[], value: string): string[] {
  const filtered = list.filter((v) => v !== value);
  filtered.unshift(value);
  return filtered.slice(0, MAX_RECENT);
}

export const useVaultStore = create<VaultState>()(
  persist(
    (set) => ({
      ...DEFAULT_LAYOUT,
      vaults: [],
      selected: null,
      searchResults: [],
      graphCache: {},
      selectedSymbolId: null,
      activeFilePath: null,
      graphFilters: defaultFilters(),
      commandPaletteOpen: false,

      setVaults: (v) => set({ vaults: v }),
      select: (id) => set({ selected: id, selectedSymbolId: null, activeFilePath: null }),
      setSearchResults: (r) => set({ searchResults: r }),
      // LRU cap: the graph cache is unbounded by default, which previously
      // caused memory growth when users hopped between vaults during a long
      // session. When we would exceed GRAPH_CACHE_MAX_VAULTS, drop the oldest
      // entry by insertion order (Map preserves it, which plain objects do not
      // for fully numeric keys but do for arbitrary strings like ours).
      setGraph: (id, g) => set((s) => {
        const existing = { ...s.graphCache };
        const hadKey = id in existing;
        existing[id] = g;
        // Re-insert under the key so it becomes the most recently used entry.
        if (hadKey) {
          delete existing[id];
          existing[id] = g;
        }
        const keys = Object.keys(existing);
        if (keys.length > GRAPH_CACHE_MAX_VAULTS) {
          // Oldest entry is the first insertion-order key.
          const drop = keys.length - GRAPH_CACHE_MAX_VAULTS;
          for (let i = 0; i < drop; i++) delete existing[keys[i]];
        }
        return { graphCache: existing };
      }),
      clearGraph: (id) => set((s) => {
        if (!(id in s.graphCache)) return {};
        const next = { ...s.graphCache };
        delete next[id];
        return { graphCache: next };
      }),

      setSelectedSymbol: (id) => set((s) => ({
        selectedSymbolId: id,
        recentSymbols: id ? pushUnique(s.recentSymbols, id) : s.recentSymbols,
      })),
      setActiveFilePath: (path) => set((s) => ({
        activeFilePath: path,
        recentFiles: path ? pushUnique(s.recentFiles, path) : s.recentFiles,
      })),
      setGraphSearch: (value) => set((s) => ({ graphFilters: { ...s.graphFilters, search: value } })),
      setGraphFileFilter: (value) => set((s) => ({ graphFilters: { ...s.graphFilters, fileFilter: value } })),
      toggleGraphKind: (kind) => set((s) => ({
        graphFilters: {
          ...s.graphFilters,
          kinds: { ...s.graphFilters.kinds, [kind]: !s.graphFilters.kinds[kind] },
        },
      })),
      resetGraphFilters: () => set({ graphFilters: defaultFilters() }),

      setActiveTab: (tab) => set({ activeTab: tab }),
      setActiveRightTab: (tab) => set({ activeRightTab: tab }),
      toggleLeftPanel: () => set((s) => ({ leftPanelOpen: !s.leftPanelOpen })),
      toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
      setLeftPanelOpen: (open) => set({ leftPanelOpen: open }),
      setRightPanelOpen: (open) => set({ rightPanelOpen: open }),

      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
      toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
    }),
    {
      name: 'strada-vault-ui',
      version: 1,
      // Persist only UI layout + recent items. Vault data and in-flight state
      // (graph cache, selection, search results) stay in-memory. The safe
      // JSON storage wrapper lives in `./persist-storage` so other stores can
      // reuse the SSR/sandbox-safe fallback without duplicating the shim.
      storage: createSafeJSONStorage(),
      partialize: (state) => ({
        leftPanelOpen: state.leftPanelOpen,
        rightPanelOpen: state.rightPanelOpen,
        activeTab: state.activeTab,
        activeRightTab: state.activeRightTab,
        recentFiles: state.recentFiles,
        recentSymbols: state.recentSymbols,
        graphFilters: state.graphFilters,
      }),
    },
  ),
);
