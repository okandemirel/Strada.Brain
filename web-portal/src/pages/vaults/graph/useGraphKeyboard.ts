import { useCallback, useMemo } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { GraphNode } from './graph-types';

export interface UseGraphKeyboardOptions {
  nodes: GraphNode[];
  adjacency: Map<string, string[]>;
  focusedNodeId: string | null;
  onFocus: (id: string) => void;
  onSelect: (id: string) => void;
  onSearchFocus: () => void;
  onEscape: () => void;
  enabled?: boolean;
}

export interface UseGraphKeyboardResult {
  handlers: {
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  };
}

/**
 * Keyboard navigation hook for the accessibility overlay.
 *
 * Bindings (Obsidian-inspired):
 * - Ctrl+K / Cmd+K        → onSearchFocus
 * - / (forward slash)     → onSearchFocus
 * - Esc                   → onEscape
 * - Enter / Space         → onSelect(focusedNodeId)
 * - ArrowDown / j         → next node in label order
 * - ArrowUp / k           → previous node in label order
 * - ArrowRight / l        → next neighbor: first neighbor (sorted by id) with
 *                           id strictly greater than the focused node's id;
 *                           wraps to the lexicographically-smallest neighbor
 *                           if no such neighbor exists.
 * - ArrowLeft / h         → previous neighbor: first neighbor (reverse-sorted)
 *                           with id strictly less than the focused node's id;
 *                           wraps to the lexicographically-largest neighbor
 *                           if no such neighbor exists.
 *
 *   Rationale: ArrowRight and ArrowLeft previously both routed to the
 *   lex-smallest neighbor, which made them indistinguishable. We now
 *   partition neighbors around the focused id so the two keys traverse
 *   opposite halves of the neighbor set — predictable for screen-reader users
 *   and deterministic across renders.
 * - Tab                   → not intercepted (native traversal preserved)
 *
 * The hook returns handlers; it does NOT attach global listeners. Consumers
 * attach `handlers.onKeyDown` to whichever element should receive key events
 * (typically the overlay wrapper, and optionally the canvas wrapper).
 */
export function useGraphKeyboard(
  opts: UseGraphKeyboardOptions,
): UseGraphKeyboardResult {
  const {
    nodes,
    adjacency,
    focusedNodeId,
    onFocus,
    onSelect,
    onSearchFocus,
    onEscape,
    enabled = true,
  } = opts;

  // Stable lexicographic ordering of nodes by label, then id (tie-break).
  const orderedIds = useMemo(() => {
    return nodes
      .slice()
      .sort((a, b) => {
        const cmp = a.label.localeCompare(b.label);
        return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
      })
      .map((n) => n.id);
  }, [nodes]);

  const idIndex = useMemo(() => {
    const map = new Map<string, number>();
    orderedIds.forEach((id, i) => map.set(id, i));
    return map;
  }, [orderedIds]);

  const moveLinear = useCallback(
    (delta: 1 | -1) => {
      if (orderedIds.length === 0) return;
      if (focusedNodeId == null) {
        const firstId = orderedIds[0];
        if (firstId !== undefined) onFocus(firstId);
        return;
      }
      const idx = idIndex.get(focusedNodeId);
      if (idx === undefined) {
        const firstId = orderedIds[0];
        if (firstId !== undefined) onFocus(firstId);
        return;
      }
      const nextIdx = Math.min(
        orderedIds.length - 1,
        Math.max(0, idx + delta),
      );
      const nextId = orderedIds[nextIdx];
      if (nextId !== undefined && nextId !== focusedNodeId) onFocus(nextId);
    },
    [orderedIds, idIndex, focusedNodeId, onFocus],
  );

  /**
   * Move "right" through the neighbor set: pick the first neighbor with an
   * id strictly greater than the focused id (lex-sorted). Wraps to the
   * smallest neighbor if the focused id is already the largest.
   */
  const moveToNextNeighbor = useCallback(() => {
    if (focusedNodeId == null) return;
    const neighbors = adjacency.get(focusedNodeId);
    if (!neighbors || neighbors.length === 0) return;
    const sorted = neighbors.slice().sort((a, b) => a.localeCompare(b));
    let target: string | undefined;
    for (const n of sorted) {
      if (n.localeCompare(focusedNodeId) > 0) {
        target = n;
        break;
      }
    }
    if (target === undefined) target = sorted[0]; // wrap-around
    if (target !== undefined && target !== focusedNodeId) onFocus(target);
  }, [adjacency, focusedNodeId, onFocus]);

  /**
   * Move "left" through the neighbor set: pick the largest neighbor with an
   * id strictly less than the focused id (lex-sorted). Wraps to the largest
   * neighbor if the focused id is already the smallest.
   */
  const moveToPrevNeighbor = useCallback(() => {
    if (focusedNodeId == null) return;
    const neighbors = adjacency.get(focusedNodeId);
    if (!neighbors || neighbors.length === 0) return;
    const sorted = neighbors.slice().sort((a, b) => a.localeCompare(b));
    let target: string | undefined;
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const n = sorted[i];
      if (n.localeCompare(focusedNodeId) < 0) {
        target = n;
        break;
      }
    }
    if (target === undefined) target = sorted[sorted.length - 1]; // wrap-around
    if (target !== undefined && target !== focusedNodeId) onFocus(target);
  }, [adjacency, focusedNodeId, onFocus]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      if (!enabled) return;

      // Search shortcut: Ctrl/Cmd+K or "/"
      const isMeta = e.ctrlKey || e.metaKey;
      if (isMeta && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        onSearchFocus();
        return;
      }
      if (e.key === '/' && !isMeta && !e.altKey) {
        e.preventDefault();
        onSearchFocus();
        return;
      }

      // Do NOT intercept Tab — preserve native focus traversal.
      if (e.key === 'Tab') return;

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          onEscape();
          return;
        case 'Enter':
        case ' ':
          if (focusedNodeId != null) {
            e.preventDefault();
            onSelect(focusedNodeId);
          }
          return;
        case 'ArrowDown':
        case 'j':
        case 'J':
          e.preventDefault();
          moveLinear(1);
          return;
        case 'ArrowUp':
        case 'k':
        case 'K':
          e.preventDefault();
          moveLinear(-1);
          return;
        case 'ArrowRight':
        case 'l':
        case 'L':
          e.preventDefault();
          moveToNextNeighbor();
          return;
        case 'ArrowLeft':
        case 'h':
        case 'H':
          e.preventDefault();
          moveToPrevNeighbor();
          return;
        default:
          return;
      }
    },
    [
      enabled,
      focusedNodeId,
      moveLinear,
      moveToNextNeighbor,
      moveToPrevNeighbor,
      onEscape,
      onSearchFocus,
      onSelect,
    ],
  );

  return { handlers: { onKeyDown } };
}
