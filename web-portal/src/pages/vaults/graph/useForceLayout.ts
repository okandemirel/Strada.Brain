import { useMemo, useRef } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationNodeDatum,
} from 'd3-force';
import { FORCE_LAYOUT_NODE_CAP as SHARED_FORCE_LAYOUT_NODE_CAP } from '../constants';

export interface LayoutInputNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}
export interface LayoutInputEdge {
  source: string;
  target: string;
}
export interface LayoutedPosition {
  id: string;
  x: number;
  y: number;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  width: number;
  height: number;
}

/**
 * Hard cap above which the synchronous force layout is skipped — the main
 * thread would otherwise freeze for multiple seconds. Above this size, callers
 * fall back to backend-provided x/y. Phase B will lift this by running the
 * simulation in a Web Worker.
 *
 * Re-exported from the shared vault constants file so callers can import it
 * from either location; the numeric source of truth lives in constants.ts.
 */
export const FORCE_LAYOUT_NODE_CAP = SHARED_FORCE_LAYOUT_NODE_CAP;

/**
 * Synchronous d3-force layout — runs N iterations up-front, returns stable
 * positions. Phase A: ~150 iterations on the main thread. For larger graphs
 * (>FORCE_LAYOUT_NODE_CAP nodes), returns input positions unchanged to avoid
 * blocking the UI.
 */
export function runForceLayout(
  nodes: LayoutInputNode[],
  edges: LayoutInputEdge[],
  iterations = 150,
): LayoutedPosition[] {
  if (nodes.length === 0) return [];
  if (nodes.length > FORCE_LAYOUT_NODE_CAP) {
    // Over the main-thread budget — pass through input positions unchanged.
    return nodes.map((n) => ({
      id: n.id,
      x: Number.isFinite(n.x) ? (n.x as number) : 0,
      y: Number.isFinite(n.y) ? (n.y as number) : 0,
    }));
  }

  const simNodes: SimNode[] = nodes.map((n, i) => ({
    id: n.id,
    // Deterministic seed so layouts are stable between reloads when the set doesn't change.
    x: n.x ?? Math.cos(i) * 80,
    y: n.y ?? Math.sin(i) * 80,
    width: n.width ?? 220,
    height: n.height ?? 60,
  }));

  const idSet = new Set(simNodes.map((n) => n.id));
  const simLinks = edges
    .filter((e) => idSet.has(e.source) && idSet.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));

  const sim = forceSimulation<SimNode>(simNodes)
    .force(
      'link',
      forceLink<SimNode, (typeof simLinks)[number]>(simLinks)
        .id((d) => d.id)
        .distance(140)
        .strength(0.6),
    )
    .force('charge', forceManyBody<SimNode>().strength(-520))
    .force('center', forceCenter(0, 0))
    .force(
      'collide',
      forceCollide<SimNode>().radius((d) => Math.max(d.width, d.height) / 2 + 8).strength(0.9),
    )
    .stop();

  for (let i = 0; i < iterations; i++) sim.tick();

  return simNodes.map((n) => ({ id: n.id, x: n.x ?? 0, y: n.y ?? 0 }));
}

/**
 * Memoized layout hook — recomputes only when the (node id set, edge id set,
 * iterations) tuple changes. A simple deep-enough signature avoids re-layout
 * on every filter flip (filter changes hide/show but don't reposition).
 *
 * Dev-mode safety net: the layout is memoized on a string signature of node
 * ids, which means mutating the node array *in place* (same ids, different
 * contents) would return a stale layout. A dev-only structural check warns
 * when the signature is stable but the node reference changed — that is the
 * shape a silent regression would take. Stripped at build time in production.
 */
export function useForceLayout(
  nodes: LayoutInputNode[],
  edges: LayoutInputEdge[],
  iterations = 150,
): Map<string, LayoutedPosition> {
  const signature = useMemo(() => {
    const nodeIds = nodes.map((n) => n.id).sort().join('|');
    const edgeIds = edges.map((e) => `${e.source}>${e.target}`).sort().join('|');
    return `${iterations}::${nodeIds}::${edgeIds}`;
  }, [nodes, edges, iterations]);

  // Dev-only: track (signature, nodes-reference). If the signature stays the
  // same but the array reference changes, the caller is mutating node
  // contents while holding the same ids — warn rather than silently serve
  // the memoized layout. Hook is unconditional; the env check just gates the
  // comparison so production has zero overhead.
  const lastSeenRef = useRef<{ sig: string; nodes: LayoutInputNode[] } | null>(null);
  if (process.env.NODE_ENV !== 'production') {
    const last = lastSeenRef.current;
    if (last && last.sig === signature && last.nodes !== nodes) {
      console.warn(
        '[useForceLayout] node array reference changed while id signature stayed stable — ' +
        'possible in-place mutation. Layout will not recompute until a node id changes.',
      );
    }
    lastSeenRef.current = { sig: signature, nodes };
  }

  return useMemo(() => {
    const positions = runForceLayout(nodes, edges, iterations);
    return new Map(positions.map((p) => [p.id, p]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}
