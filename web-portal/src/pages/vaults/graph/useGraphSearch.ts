import { useMemo } from 'react';

import type { GraphNode } from './graph-types';
import { fuzzyMatch } from './search-utils';

export interface GraphSearchMatch {
  node: GraphNode;
  score: number;
  ranges: [number, number][];
}

export interface UseGraphSearchOptions {
  nodes: GraphNode[];
  query: string;
  maxResults?: number;
}

export interface UseGraphSearchResult {
  matches: GraphSearchMatch[];
  matchedIds: Set<string>;
  topMatchId: string | null;
  total: number;
}

const DEFAULT_MAX_RESULTS = 50;

const EMPTY_RESULT: UseGraphSearchResult = {
  matches: [],
  matchedIds: new Set<string>(),
  topMatchId: null,
  total: 0,
};

/**
 * Fuzzy-search a set of graph nodes by their `label`.
 *
 * Memoised on `(nodes, query, maxResults)` — callers can pass a fresh nodes
 * array each render as long as the underlying reference is stable.
 *
 * Results are sorted by score (desc) then by label (asc) so ties are stable,
 * and capped at `maxResults`. `total` reports the unbounded match count so
 * the UI can show "showing 50 of 142".
 */
export function useGraphSearch(opts: UseGraphSearchOptions): UseGraphSearchResult {
  const { nodes, query, maxResults = DEFAULT_MAX_RESULTS } = opts;

  return useMemo<UseGraphSearchResult>(() => {
    const trimmed = query.trim();
    if (!trimmed) return EMPTY_RESULT;

    const scored: GraphSearchMatch[] = [];
    for (const node of nodes) {
      const m = fuzzyMatch(trimmed, node.label);
      if (m) {
        scored.push({ node, score: m.score, ranges: m.ranges });
      }
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.node.label.localeCompare(b.node.label);
    });

    const total = scored.length;
    const matches = scored.slice(0, Math.max(0, maxResults));
    const matchedIds = new Set<string>();
    for (const m of matches) matchedIds.add(m.node.id);
    const topMatchId = matches.length > 0 ? matches[0].node.id : null;

    return { matches, matchedIds, topMatchId, total };
  }, [nodes, query, maxResults]);
}
