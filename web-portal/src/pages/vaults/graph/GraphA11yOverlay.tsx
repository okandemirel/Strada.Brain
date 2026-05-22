import { useEffect, useMemo, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { GraphLink, GraphNode } from './graph-types';
import { useGraphKeyboard } from './useGraphKeyboard';

export interface GraphA11yKeyboardHandlers {
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
}

export interface GraphA11yOverlayProps {
  nodes: GraphNode[];
  links: GraphLink[];
  selectedNodeId: string | null;
  focusedNodeId: string | null;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  /** Optional precomputed adjacency map (nodeId -> neighbor ids). */
  adjacency?: Map<string, string[]>;
  /** Optional handlers wired by the host page. Default to no-ops. */
  onSearchFocus?: () => void;
  onEscape?: () => void;
  /**
   * Optional preconstructed keyboard handlers (e.g. from a host-level
   * `useGraphKeyboard` call). When supplied, the overlay reuses them instead
   * of constructing its own — avoiding duplicate hook instances and keeping
   * navigation state consistent between the canvas and the a11y tree.
   * When omitted (legacy callers), the overlay builds its own.
   */
  keyboardHandlers?: GraphA11yKeyboardHandlers;
}

/**
 * Tailwind v4 ships `sr-only` natively, but we provide an inline fallback so
 * this overlay remains self-contained and visually hidden even if the global
 * stylesheet ever drops the utility.
 */
const SR_ONLY_STYLE = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const;

function endpointId(end: string | GraphNode): string {
  return typeof end === 'string' ? end : end.id;
}

function buildAdjacency(
  nodes: GraphNode[],
  links: GraphLink[],
): Map<string, string[]> {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const link of links) {
    const a = endpointId(link.source);
    const b = endpointId(link.target);
    if (!nodeIds.has(a) || !nodeIds.has(b)) continue;
    adj.get(a)?.add(b);
    adj.get(b)?.add(a);
  }
  const result = new Map<string, string[]>();
  for (const [id, set] of adj) result.set(id, Array.from(set));
  return result;
}

export function GraphA11yOverlay(props: GraphA11yOverlayProps) {
  const {
    nodes,
    links,
    selectedNodeId,
    focusedNodeId,
    onSelect,
    onFocus,
    adjacency: adjacencyProp,
    onSearchFocus,
    onEscape,
    keyboardHandlers,
  } = props;

  const { t } = useTranslation('vault');
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const liveRegionRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  const adjacency = useMemo(
    () => adjacencyProp ?? buildAdjacency(nodes, links),
    [adjacencyProp, nodes, links],
  );

  // O(1) lookup map for node-by-id — replaces O(N) `nodes.find()` inside the
  // neighbor-description render loop (previously O(N*M)).
  const nodeById = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const n of nodes) map.set(n.id, n);
    return map;
  }, [nodes]);

  // Lexicographic ordering for stable list/tree presentation.
  const orderedNodes = useMemo(() => {
    return nodes.slice().sort((a, b) => {
      const cmp = a.label.localeCompare(b.label);
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    });
  }, [nodes]);

  const focusedConnectionCount = useMemo(() => {
    if (focusedNodeId == null) return 0;
    return adjacency.get(focusedNodeId)?.length ?? 0;
  }, [adjacency, focusedNodeId]);

  const focusedLabel = useMemo(() => {
    if (focusedNodeId == null) return '';
    return nodeById.get(focusedNodeId)?.label ?? focusedNodeId;
  }, [nodeById, focusedNodeId]);

  const noopSearch = useMemo(() => onSearchFocus ?? (() => {}), [onSearchFocus]);
  const noopEscape = useMemo(() => onEscape ?? (() => {}), [onEscape]);

  // Only construct our own keyboard handlers when the host didn't supply any.
  // The hook is always called (rules of hooks), but its result is ignored
  // when `keyboardHandlers` is provided.
  const ownKeyboard = useGraphKeyboard({
    nodes,
    adjacency,
    focusedNodeId,
    onFocus,
    onSelect,
    onSearchFocus: noopSearch,
    onEscape: noopEscape,
    enabled: keyboardHandlers === undefined,
  });

  const handlers = keyboardHandlers ?? ownKeyboard.handlers;

  // Move DOM focus to the currently-focused treeitem ONLY when the active
  // element is already inside this overlay. Otherwise we'd steal focus from
  // the canvas (or any other host element) every time the host updates
  // `focusedNodeId`, which breaks keyboard navigation from the canvas.
  useEffect(() => {
    if (focusedNodeId == null) return;
    const el = itemRefs.current.get(focusedNodeId);
    if (!el) return;
    const wrapper = wrapperRef.current;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const focusIsInside = !!wrapper && !!active && wrapper.contains(active);
    if (focusIsInside && active !== el) {
      el.focus({ preventScroll: true });
    }
    // When focus is outside the overlay we still want aria-selected to update
    // — that happens implicitly via the `isSelected` render below.
  }, [focusedNodeId]);

  return (
    <div
      ref={wrapperRef}
      role="application"
      aria-label={t('graph.a11y.regionLabel')}
      aria-roledescription={t('graph.a11y.nodeRole')}
      onKeyDown={handlers.onKeyDown}
      style={SR_ONLY_STYLE}
      className="sr-only"
    >
      <p>{t('graph.a11y.nodeCount', { count: nodes.length })}</p>
      <p>{t('graph.a11y.navigationHint')}</p>

      <div
        ref={liveRegionRef}
        aria-live="polite"
        aria-atomic="true"
        style={SR_ONLY_STYLE}
      >
        {focusedNodeId
          ? t('graph.a11y.selectedHint', {
              label: focusedLabel,
              count: focusedConnectionCount,
            })
          : ''}
      </div>

      <ul role="tree" aria-label={t('graph.a11y.regionLabel')}>
        {orderedNodes.map((node) => {
          const isFocused = node.id === focusedNodeId;
          const isSelected = node.id === selectedNodeId;
          const neighbors = adjacency.get(node.id) ?? [];
          const descId = `graph-a11y-desc-${node.id}`;
          return (
            <li
              key={node.id}
              role="treeitem"
              tabIndex={isFocused ? 0 : -1}
              aria-selected={isSelected}
              aria-describedby={descId}
              ref={(el) => {
                if (el) itemRefs.current.set(node.id, el);
                else itemRefs.current.delete(node.id);
              }}
              onFocus={() => {
                if (node.id !== focusedNodeId) onFocus(node.id);
              }}
              onClick={() => onSelect(node.id)}
              onKeyDown={handlers.onKeyDown}
            >
              {node.label}
              <span id={descId} style={SR_ONLY_STYLE}>
                {neighbors.length === 0
                  ? ''
                  : `${neighbors.length}: ${neighbors
                      .slice(0, 12)
                      .map((nid) => nodeById.get(nid)?.label ?? nid)
                      .join(', ')}`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default GraphA11yOverlay;
