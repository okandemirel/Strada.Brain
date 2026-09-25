export interface Ranked { chunkId: string; score: number; }

export interface Fused {
  chunkId: string;
  rrf: number;
  ftsRank: number | null;
  hnswRank: number | null;
}

/**
 * Reciprocal Rank Fusion of two ranked lists.
 * @param k smoothing constant; smaller k punishes lower ranks more heavily.
 * @returns fused list sorted by RRF score descending.
 */
export function rrfFuse(fts: Ranked[], hnsw: Ranked[], k: number): Fused[] {
  const map = new Map<string, Fused>();
  const add = (list: Ranked[], setRank: (f: Fused, rank: number) => void) => {
    list.forEach((entry, idx) => {
      const rank = idx + 1;
      const existing = map.get(entry.chunkId) ?? { chunkId: entry.chunkId, rrf: 0, ftsRank: null, hnswRank: null };
      existing.rrf += 1 / (k + rank);
      setRank(existing, rank);
      map.set(entry.chunkId, existing);
    });
  };
  add(fts, (f, r) => { f.ftsRank = r; });
  add(hnsw, (f, r) => { f.hnswRank = r; });
  return [...map.values()].sort((a, b) => b.rrf - a.rrf);
}

/**
 * How many extra candidates to retrieve per requested result when a
 * langFilter/pathGlob is active. Filtering happens after retrieval, so the
 * candidate pool must be wider than topK or a selective filter starves the
 * result set. 5x covers a filter that matches ~20% of the corpus.
 */
const FILTER_OVERFETCH = 5;

/** Hard ceiling on the over-fetch, so a large topK cannot turn one query into
 *  an unbounded scan. */
const MAX_FETCH_K = 200;

/**
 * Candidates to retrieve for a query. Shared by every vault's query so the
 * over-fetch cannot drift between copies again (MEM-18): the cut to topK must
 * happen after langFilter/pathGlob, never before.
 */
export function candidateFetchK(topK: number, q: { langFilter?: readonly unknown[]; pathGlob?: string }): number {
  const filtersActive = Boolean(q.langFilter?.length || q.pathGlob);
  return filtersActive ? Math.min(topK * FILTER_OVERFETCH, MAX_FETCH_K) : topK;
}

/**
 * Greedily pick items in order until budget exhausted; remaining go to `dropped`.
 * Items are processed in input order — caller is responsible for pre-sorting by relevance.
 */
export function packByBudget<T extends { tokenCount: number }>(items: T[], budget: number): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  let used = 0;
  for (const it of items) {
    if (used + it.tokenCount <= budget) { kept.push(it); used += it.tokenCount; }
    else dropped.push(it);
  }
  return { kept, dropped };
}
