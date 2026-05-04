import { useState, useMemo, useCallback } from 'react';
import type { GraphLink } from './graph-types';

interface UseGraphInteractionsOptions {
  links: GraphLink[];
}

export function extractNodeId(raw: string | { id: string } | unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && 'id' in raw) return (raw as { id: string }).id;
  return String(raw);
}

export interface GraphInteractions {
  hoverNode: string | null;
  setHoverNode: (id: string | null) => void;
  isHighlighted: (nodeId: string) => boolean;
  isLinkHighlighted: (source: string, target: string) => boolean;
  highlightedOpacity: (isHighlighted: boolean) => number;
  adjacency: Map<string, Set<string>>;
  connectionCounts: Map<string, number>;
}

export function useGraphInteractions({ links }: UseGraphInteractionsOptions): GraphInteractions {
  const [hoverNode, setHoverNode] = useState<string | null>(null);

  const adjacency = useMemo(() => {
    const adj = new Map<string, Set<string>>();
    for (const link of links) {
      const s = extractNodeId(link.source);
      const t = extractNodeId(link.target);
      if (!adj.has(s)) adj.set(s, new Set());
      if (!adj.has(t)) adj.set(t, new Set());
      adj.get(s)!.add(t);
      adj.get(t)!.add(s);
    }
    return adj;
  }, [links]);

  const connectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of links) {
      const s = extractNodeId(link.source);
      const t = extractNodeId(link.target);
      counts.set(s, (counts.get(s) ?? 0) + 1);
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return counts;
  }, [links]);

  const isHighlighted = useCallback(
    (nodeId: string) => {
      if (!hoverNode) return true;
      if (nodeId === hoverNode) return true;
      return adjacency.get(hoverNode)?.has(nodeId) ?? false;
    },
    [hoverNode, adjacency],
  );

  const isLinkHighlighted = useCallback(
    (source: string, target: string) => {
      if (!hoverNode) return true;
      return source === hoverNode || target === hoverNode;
    },
    [hoverNode],
  );

  const highlightedOpacity = useCallback(
    (highlighted: boolean) => {
      if (!hoverNode) return 0.9;
      return highlighted ? 1.0 : 0.12;
    },
    [hoverNode],
  );

  return {
    hoverNode,
    setHoverNode,
    isHighlighted,
    isLinkHighlighted,
    highlightedOpacity,
    adjacency,
    connectionCounts,
  };
}
