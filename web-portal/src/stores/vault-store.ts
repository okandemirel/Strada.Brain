import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { MAX_RECENT, GRAPH_CACHE_MAX_VAULTS } from '../pages/vaults/constants';
import { createSafeJSONStorage } from './persist-storage';

/** Cap on persisted per-vault viewport entries; oldest entries are evicted in LRU order. */
const VAULT_VIEWPORT_CACHE_LIMIT = 20;

export interface VaultSummary { id: string; kind: string; }
export interface SearchHit {
  chunk: { chunkId: string; path: string; startLine: number; endLine: number; content: string; tokenCount: number };
  scores: { fts: number | null; hnsw: number | null; rrf: number };
}

export interface CanvasNode {
  id: string; type: 'text'; text: string;
  x: number; y: number; width: number; height: number;
  color?: string; file?: string; kind?: string;
  weight?: number; group?: string;
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

/** Per-vault graph viewport (world-space centre + zoom). Persisted in LRU map. */
export interface VaultGraphViewport {
  x: number;
  y: number;
  zoom: number;
  /** Last-selected symbol id at the time the viewport was stored. */
  selectedNodeId: string | null;
  /** Insertion timestamp for LRU eviction. */
  updatedAt: number;
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
  /** LRU map of vaultId → last-known viewport (centre + zoom). */
  vaultViewports: Record<string, VaultGraphViewport>;

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
  setGraphKindsAll(value: boolean): void;
  resetGraphFilters(): void;

  /** Persist the graph viewport for a vault; performs LRU eviction. */
  setVaultViewport(vaultId: string, viewport: Omit<VaultGraphViewport, 'updatedAt'>): void;
  /** Read a previously-persisted viewport for a vault (no-op if missing). */
  getVaultViewport(vaultId: string): VaultGraphViewport | undefined;

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

/**
 * Defensive schema check for a persisted viewport entry.
 *
 * Tampered or corrupt `localStorage` can inject `NaN`, `Infinity`, or wrong
 * types. NaN propagates into `d3-zoom` and freezes the canvas; non-finite
 * `updatedAt` breaks LRU ordering. Anything that fails this check is dropped
 * on rehydrate and rejected on write.
 */
function isValidViewport(v: unknown): v is VaultGraphViewport {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (!Number.isFinite(r.x)) return false;
  if (!Number.isFinite(r.y)) return false;
  if (!Number.isFinite(r.zoom)) return false;
  if (!Number.isFinite(r.updatedAt)) return false;
  if (r.selectedNodeId !== null && typeof r.selectedNodeId !== 'string') return false;
  return true;
}

function sanitizeVaultViewports(
  raw: unknown,
): Record<string, VaultGraphViewport> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, VaultGraphViewport> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.length === 0) continue;
    if (isValidViewport(value)) {
      out[key] = value;
    }
  }
  return out;
}

export const useVaultStore = create<VaultState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_LAYOUT,
      vaults: [],
      selected: null,
      searchResults: [],
      graphCache: {},
      selectedSymbolId: null,
      activeFilePath: null,
      graphFilters: defaultFilters(),
      vaultViewports: {},
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
      setGraphKindsAll: (value) => set((s) => ({
        graphFilters: {
          ...s.graphFilters,
          kinds: Object.fromEntries(
            ALL_SYMBOL_KINDS.map((k) => [k, value]),
          ) as Record<SymbolKind, boolean>,
        },
      })),
      resetGraphFilters: () => set({ graphFilters: defaultFilters() }),

      setVaultViewport: (vaultId, viewport) => set((s) => {
        // Defensive: reject non-finite numeric inputs from callers. A tampered
        // d3-zoom event or a math bug upstream can produce NaN; persisting it
        // would freeze the canvas on next mount.
        if (
          !vaultId
          || !Number.isFinite(viewport.x)
          || !Number.isFinite(viewport.y)
          || !Number.isFinite(viewport.zoom)
          || (viewport.selectedNodeId !== null && typeof viewport.selectedNodeId !== 'string')
        ) {
          return {};
        }
        const next: Record<string, VaultGraphViewport> = { ...s.vaultViewports };
        next[vaultId] = { ...viewport, updatedAt: Date.now() };
        // LRU cap: traverse Object.entries once, sort by updatedAt desc, keep
        // the newest VAULT_VIEWPORT_CACHE_LIMIT entries. Avoids the previous
        // O(n) key-lookup chain (Object.keys + per-key map lookup) by reading
        // the value alongside the key in a single pass.
        const entries = Object.entries(next);
        if (entries.length > VAULT_VIEWPORT_CACHE_LIMIT) {
          entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
          const kept: Record<string, VaultGraphViewport> = {};
          for (let i = 0; i < VAULT_VIEWPORT_CACHE_LIMIT; i += 1) {
            const e = entries[i];
            if (e) kept[e[0]] = e[1];
          }
          return { vaultViewports: kept };
        }
        return { vaultViewports: next };
      }),
      getVaultViewport: (vaultId) => get().vaultViewports[vaultId],

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
        vaultViewports: state.vaultViewports,
      }),
      // Sanitize the rehydrated payload: localStorage can be edited by hand or
      // corrupted by an older app version. Drop any viewport entry whose
      // x/y/zoom/updatedAt are not finite or whose selectedNodeId is malformed,
      // since those values would propagate NaN into d3-zoom and freeze the
      // canvas (and break the LRU sort, which compares updatedAt numerically).
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<VaultState>;
        const merged: VaultState = { ...currentState, ...persisted };
        merged.vaultViewports = sanitizeVaultViewports(
          (persisted as { vaultViewports?: unknown }).vaultViewports,
        );
        return merged;
      },
    },
  ),
);
