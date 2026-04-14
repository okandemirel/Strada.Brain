import { create } from 'zustand';

export interface VaultSummary { id: string; kind: string; }
export interface SearchHit {
  chunk: { chunkId: string; path: string; startLine: number; endLine: number; content: string; tokenCount: number };
  scores: { fts: number | null; hnsw: number | null; rrf: number };
}

interface VaultState {
  vaults: VaultSummary[];
  selected: string | null;
  searchResults: SearchHit[];
  setVaults(v: VaultSummary[]): void;
  select(id: string): void;
  setSearchResults(r: SearchHit[]): void;
}

export const useVaultStore = create<VaultState>((set) => ({
  vaults: [],
  selected: null,
  searchResults: [],
  setVaults: (v) => set({ vaults: v }),
  select: (id) => set({ selected: id }),
  setSearchResults: (r) => set({ searchResults: r }),
}));
