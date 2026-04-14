import { create } from 'zustand';

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

interface VaultState {
  vaults: VaultSummary[];
  selected: string | null;
  searchResults: SearchHit[];
  graphCache: Record<string, CanvasJson | null>;
  setVaults(v: VaultSummary[]): void;
  select(id: string): void;
  setSearchResults(r: SearchHit[]): void;
  setGraph(id: string, g: CanvasJson | null): void;
}

export const useVaultStore = create<VaultState>((set) => ({
  vaults: [],
  selected: null,
  searchResults: [],
  graphCache: {},
  setVaults: (v) => set({ vaults: v }),
  select: (id) => set({ selected: id }),
  setSearchResults: (r) => set({ searchResults: r }),
  setGraph: (id, g) => set((s) => ({ graphCache: { ...s.graphCache, [id]: g } })),
}));
