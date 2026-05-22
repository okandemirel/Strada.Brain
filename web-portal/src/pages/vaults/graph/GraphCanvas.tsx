import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { ForceGraphMethods } from 'react-force-graph-2d';
import { useTranslation } from 'react-i18next';

import {
  useVaultStore,
  type CanvasJson,
  type SymbolKind,
  ALL_SYMBOL_KINDS,
} from '../../../stores/vault-store';
import { useGraphInteractions, extractNodeId } from './useGraphInteractions';
import { parseNodeText, getKindStyle, KIND_STYLE_MAP } from './node-style';
import { GraphNodeOverlay } from './GraphNodeOverlay';
import { GraphNodeTooltip } from './GraphNodeTooltip';
import GraphMinimap, {
  type MinimapViewport,
  type MinimapWorldBounds,
} from './GraphMinimap';
import { useForceSimulation } from './useForceSimulation';
import { DEFAULT_SIM_CONFIG, type SimConfig } from './force-simulation-types';
import { useGraphSearch } from './useGraphSearch';
import { GraphA11yOverlay } from './GraphA11yOverlay';
import { useGraphKeyboard } from './useGraphKeyboard';
import { useGraphColors, applyEdgeAlpha, type GraphColors } from './useGraphTheme';
import type { GraphLink, GraphNode } from './graph-types';

interface Props {
  graph: CanvasJson;
}

const FOLDER_PALETTE = [
  '#8B7AB8', '#5B8DB8', '#7AB88B', '#B8A87A', '#B87A9B', '#888888',
  '#7A8BB8', '#B87A7A', '#7AB8B8', '#B8B87A',
];

interface PhysicsPreset {
  linkDistance: number;
  chargeStrength: number;
  collideRadius: number;
}

const PHYSICS_PRESETS: Record<'sparse' | 'balanced' | 'dense', PhysicsPreset> = {
  sparse:   { linkDistance: 220, chargeStrength: -240, collideRadius: 14 },
  balanced: { linkDistance: 120, chargeStrength: -120, collideRadius: 10 },
  dense:    { linkDistance: 70,  chargeStrength: -60,  collideRadius: 6 },
};

type HopDepth = 1 | 2 | 3;

interface BuildOptions {
  graph: CanvasJson;
  showOrphans: boolean;
  groupBy: 'lang' | 'folder';
  nodeSizeMode: 'connections' | 'uniform';
  localGraphMode: boolean;
  localGraphCenter: string | null;
  localGraphHopDepth: HopDepth;
  enabledKinds: Record<SymbolKind, boolean>;
  maxNodes: number;
}

interface BuildResult {
  nodes: GraphNode[];
  links: GraphLink[];
  connectionCounts: Map<string, number>;
  /** True when the source graph exceeded `maxNodes` and was truncated. */
  truncated: boolean;
  /** Aggregated edge weights keyed by canonical "a|b" (a < b). */
  edgeWeights: Map<string, number>;
}

function canonicalEdgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function isEnabledKind(
  kind: string | null,
  enabledKinds: Record<SymbolKind, boolean>,
): boolean {
  if (!kind) return true; // Unknown kinds (e.g., "file", fallback) stay visible.
  const known = (ALL_SYMBOL_KINDS as readonly string[]).includes(kind);
  if (!known) return true;
  return enabledKinds[kind as SymbolKind] !== false;
}

function buildGraphData(opts: BuildOptions): BuildResult {
  const {
    graph,
    showOrphans,
    groupBy,
    nodeSizeMode,
    localGraphMode,
    localGraphCenter,
    localGraphHopDepth,
    enabledKinds,
    maxNodes,
  } = opts;

  const connectionCounts = new Map<string, number>();
  for (const e of graph.edges) {
    connectionCounts.set(e.fromNode, (connectionCounts.get(e.fromNode) ?? 0) + 1);
    connectionCounts.set(e.toNode, (connectionCounts.get(e.toNode) ?? 0) + 1);
  }

  const folderColorMap = new Map<string, string>();
  let folderColorIdx = 0;
  function getFolderColor(dir: string): string {
    if (!folderColorMap.has(dir)) {
      folderColorMap.set(dir, FOLDER_PALETTE[folderColorIdx % FOLDER_PALETTE.length]!);
      folderColorIdx++;
    }
    return folderColorMap.get(dir)!;
  }

  const allNodes: GraphNode[] = graph.nodes
    .filter((n) => showOrphans || (connectionCounts.get(n.id) ?? 0) > 0)
    .map((n) => {
      const parsed = parseNodeText(n.text);
      const kind = n.kind ?? parsed.kind;
      const connCount = connectionCounts.get(n.id) ?? 0;
      const color = groupBy === 'folder' && n.group
        ? getFolderColor(n.group)
        : (n.color ?? '#888888');
      const val = nodeSizeMode === 'uniform' ? 1 : Math.max(connCount, 1);

      return {
        id: n.id,
        label: parsed.name || n.text.split('/').pop() || n.id,
        kind,
        color,
        val,
        file: n.file ?? parsed.file ?? null,
        line: parsed.line ?? null,
      };
    })
    .filter((n) => isEnabledKind(n.kind, enabledKinds));

  // Enforce hard cap on simulated nodes; prefer higher-connection nodes.
  let nodes = allNodes;
  let truncated = false;
  if (allNodes.length > maxNodes) {
    truncated = true;
    nodes = allNodes
      .slice()
      .sort((a, b) => (connectionCounts.get(b.id) ?? 0) - (connectionCounts.get(a.id) ?? 0))
      .slice(0, maxNodes);
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  let links: GraphLink[] = graph.edges
    .filter((e) => nodeIds.has(e.fromNode) && nodeIds.has(e.toNode))
    .map((e) => ({ source: e.fromNode, target: e.toNode, label: e.label }));

  if (localGraphMode && localGraphCenter && nodeIds.has(localGraphCenter)) {
    // BFS from centre up to N hops.
    const adjacency = new Map<string, Set<string>>();
    for (const l of links) {
      const s = extractNodeId(l.source);
      const t = extractNodeId(l.target);
      if (!adjacency.has(s)) adjacency.set(s, new Set());
      if (!adjacency.has(t)) adjacency.set(t, new Set());
      adjacency.get(s)!.add(t);
      adjacency.get(t)!.add(s);
    }
    const visited = new Set<string>([localGraphCenter]);
    let frontier: string[] = [localGraphCenter];
    for (let hop = 0; hop < localGraphHopDepth; hop += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        const neighbours = adjacency.get(id);
        if (!neighbours) continue;
        for (const n of neighbours) {
          if (!visited.has(n)) {
            visited.add(n);
            next.push(n);
          }
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
    nodes = nodes.filter((n) => visited.has(n.id));
    const filteredIds = new Set(nodes.map((n) => n.id));
    links = links.filter((l) => {
      const s = extractNodeId(l.source);
      const t = extractNodeId(l.target);
      return filteredIds.has(s) && filteredIds.has(t);
    });
  }

  const edgeWeights = new Map<string, number>();
  for (const l of links) {
    const s = extractNodeId(l.source);
    const t = extractNodeId(l.target);
    const key = canonicalEdgeKey(s, t);
    edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1);
  }

  return { nodes, links, connectionCounts, truncated, edgeWeights };
}

function drawNodeGlow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  opacity: number,
) {
  ctx.beginPath();
  ctx.arc(x, y, radius + 6, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.15;
  ctx.fill();
  ctx.globalAlpha = opacity;
}

function drawNodeCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  isMatching: boolean,
  time: number,
) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  if (isMatching) {
    const pulse = 0.7 + 0.3 * Math.sin(time * 0.008);
    ctx.globalAlpha = pulse;
  }
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawNodeBorder(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  globalScale: number,
  isSelected: boolean,
  colors: GraphColors,
) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.strokeStyle = isSelected ? colors.nodeSelectedRing : colors.nodeBorderHover;
  ctx.lineWidth = isSelected ? 2.0 / globalScale : 1.2 / globalScale;
  ctx.stroke();
}

function drawNodeLabel(
  ctx: CanvasRenderingContext2D,
  node: GraphNode,
  x: number,
  y: number,
  radius: number,
  globalScale: number,
  opacity: number,
  colors: GraphColors,
) {
  const fontSize = Math.max(12 / globalScale, 6);
  ctx.font = `400 ${fontSize}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = colors.label;
  ctx.globalAlpha = opacity;

  const truncated = node.label.length > 24 ? node.label.slice(0, 22) + '…' : node.label;
  ctx.fillText(truncated, x, y + radius + 3 / globalScale);

  if (globalScale > 2.5 && node.file) {
    const fileName = node.file.split('/').pop() ?? node.file;
    const detailFontSize = Math.max(8 / globalScale, 4);
    ctx.font = `400 ${detailFontSize}px ui-monospace, SFMono-Regular, monospace`;
    ctx.fillStyle = colors.labelDetail;
    ctx.fillText(
      `${fileName}${node.line ? ':' + node.line : ''}`,
      x,
      y + radius + 3 / globalScale + fontSize + 1,
    );
  }
}

interface CenterLike {
  centerAt: (x: number, y: number, ms: number) => void;
  zoom?: (z: number, ms: number) => void;
}

export default function GraphCanvas({ graph }: Props) {
  const { t } = useTranslation('vault');
  const selectedSymbolId = useVaultStore((s) => s.selectedSymbolId);
  const setSelectedSymbol = useVaultStore((s) => s.setSelectedSymbol);
  const vaultId = useVaultStore((s) => s.selected);
  const graphKindsFilter = useVaultStore((s) => s.graphFilters.kinds);
  const toggleGraphKind = useVaultStore((s) => s.toggleGraphKind);
  const setGraphKindsAll = useVaultStore((s) => s.setGraphKindsAll);
  const setVaultViewport = useVaultStore((s) => s.setVaultViewport);
  const colors = useGraphColors();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<ForceGraphMethods<any, any> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoFitGraphRef = useRef<CanvasJson | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showOrphans, setShowOrphans] = useState(true);
  const [groupBy, setGroupBy] = useState<'lang' | 'folder'>('lang');
  const [nodeSizeMode, setNodeSizeMode] = useState<'connections' | 'uniform'>('connections');
  const [localGraphMode, setLocalGraphMode] = useState(false);
  const [localGraphCenter, setLocalGraphCenter] = useState<string | null>(null);
  const [localGraphHopDepth, setLocalGraphHopDepth] = useState<HopDepth>(1);
  const [tooltipNode, setTooltipNode] = useState<GraphNode | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [showKindFilter, setShowKindFilter] = useState(false);
  const [showAdvancedPhysics, setShowAdvancedPhysics] = useState(false);
  /**
   * Export feedback state. `null` = no toast, `'success'` = green confirmation,
   * `'error'` = surface failure reason. Auto-clears after a short delay.
   */
  const [exportStatus, setExportStatus] = useState<
    | { kind: 'success' }
    | { kind: 'error'; message: string }
    | null
  >(null);
  const [physicsConfig, setPhysicsConfig] = useState<Pick<SimConfig, 'linkDistance' | 'chargeStrength' | 'collideRadius'>>(
    () => ({
      linkDistance: PHYSICS_PRESETS.balanced.linkDistance,
      chargeStrength: PHYSICS_PRESETS.balanced.chargeStrength,
      collideRadius: PHYSICS_PRESETS.balanced.collideRadius,
    }),
  );
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<MinimapViewport>({
    x: 0, y: 0, zoom: 1, width: 0, height: 0,
  });
  const lastClickRef = useRef<{ nodeId: string; time: number } | null>(null);

  const { nodes, links, connectionCounts, truncated, edgeWeights } = useMemo(
    () => buildGraphData({
      graph,
      showOrphans,
      groupBy,
      nodeSizeMode,
      localGraphMode,
      localGraphCenter,
      localGraphHopDepth,
      enabledKinds: graphKindsFilter,
      maxNodes: DEFAULT_SIM_CONFIG.maxNodes,
    }),
    [graph, showOrphans, groupBy, nodeSizeMode, localGraphMode, localGraphCenter, localGraphHopDepth, graphKindsFilter],
  );
  const graphData = useMemo(
    (): { nodes: GraphNode[]; links: GraphLink[] } => ({ nodes, links }),
    [nodes, links],
  );

  // Fuzzy search (replaces substring matcher).
  const { matchedIds, topMatchId, total: searchTotal } = useGraphSearch({
    nodes,
    query: searchQuery,
  });
  const searchTrimmed = searchQuery.trim();

  const interactions = useGraphInteractions({ links });

  // Worker-driven force simulation runs alongside react-force-graph as a
  // future-ready signal. We feed live positions to the minimap so the overview
  // tracks the same world the renderer paints.
  const simulation = useForceSimulation({
    nodes,
    links,
    config: {
      linkDistance: physicsConfig.linkDistance,
      chargeStrength: physicsConfig.chargeStrength,
      collideRadius: physicsConfig.collideRadius,
    },
    enabled: nodes.length > 0,
  });

  // Auto-fit exactly once per source graph + restore persisted viewport if any.
  useEffect(() => {
    if (nodes.length === 0 || autoFitGraphRef.current === graph) return;
    autoFitGraphRef.current = graph;
    const persisted = vaultId ? useVaultStore.getState().vaultViewports[vaultId] : undefined;
    const timer = setTimeout(() => {
      if (persisted && Number.isFinite(persisted.x) && Number.isFinite(persisted.y)) {
        fgRef.current?.centerAt(persisted.x, persisted.y, 400);
        fgRef.current?.zoom(persisted.zoom, 400);
      } else {
        fgRef.current?.zoomToFit(300, 20);
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [graph, nodes.length, vaultId]);

  // Push physics tuning into the on-thread force graph too (visual continuity).
  // `graph` is intentionally NOT in deps: this effect doesn't read it, and the
  // `fgRef` null check already handles the unmounted state.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const linkForce = fg.d3Force('link') as any;
    if (linkForce && typeof linkForce.distance === 'function') {
      linkForce.distance(physicsConfig.linkDistance);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chargeForce = fg.d3Force('charge') as any;
    if (chargeForce && typeof chargeForce.strength === 'function') {
      chargeForce.strength(physicsConfig.chargeStrength);
    }
    fg.d3ReheatSimulation();
  }, [physicsConfig]);

  // Escape / Ctrl+K / "/" key handling lives entirely in `useGraphKeyboard`
  // (wired below). Previous duplicate global useEffects were removed to keep
  // a single keyboard-routing path.

  // Track mouse position for tooltip.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    el.addEventListener('mousemove', handler);
    return () => el.removeEventListener('mousemove', handler);
  }, []);

  // Container size for minimap viewport calculations.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setViewport((v) => ({ ...v, width: rect.width, height: rect.height }));
    };
    update();
    const obs = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (obs) obs.observe(el);
    return () => { if (obs) obs.disconnect(); };
  }, []);

  // Persist viewport on changes (debounced).
  useEffect(() => {
    if (!vaultId) return;
    if (!Number.isFinite(viewport.x) || !Number.isFinite(viewport.y) || viewport.zoom <= 0) return;
    const handle = window.setTimeout(() => {
      setVaultViewport(vaultId, {
        x: viewport.x,
        y: viewport.y,
        zoom: viewport.zoom,
        selectedNodeId: selectedSymbolId,
      });
    }, 350);
    return () => window.clearTimeout(handle);
  }, [vaultId, viewport.x, viewport.y, viewport.zoom, selectedSymbolId, setVaultViewport]);

  const nodeCanvasObject = useCallback(
    (node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const highlighted = interactions.isHighlighted(node.id);
      const opacity = interactions.highlightedOpacity(highlighted);
      const isSelected = node.id === selectedSymbolId;
      const isHovered = node.id === interactions.hoverNode;
      const isMatching = matchedIds.has(node.id);

      const baseRadius = Math.sqrt(node.val) * 4 + 5;
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const time = Date.now();

      ctx.save();
      ctx.globalAlpha = opacity;

      if (isSelected || isMatching) {
        drawNodeGlow(ctx, x, y, baseRadius, node.color, opacity);
      }

      drawNodeCircle(ctx, x, y, baseRadius, node.color, isMatching, time);

      if (isHovered || isSelected) {
        drawNodeBorder(ctx, x, y, baseRadius, globalScale, isSelected, colors);
      }

      const showLabel = globalScale > 0.5 || baseRadius > 6;
      if (showLabel) {
        drawNodeLabel(ctx, node, x, y, baseRadius, globalScale, opacity, colors);
      }

      ctx.restore();
    },
    [interactions, selectedSymbolId, matchedIds, colors],
  );

  const animateToNode = useCallback((nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node || node.x == null || node.y == null) return;
    const fg = fgRef.current as unknown as CenterLike | undefined;
    fg?.centerAt(node.x, node.y, 400);
  }, [nodes]);

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      const now = Date.now();
      if (lastClickRef.current?.nodeId === node.id && now - lastClickRef.current.time < 300) {
        // Double-click → enter local graph view with smooth zoom.
        setLocalGraphMode(true);
        setLocalGraphCenter(node.id);
        lastClickRef.current = null;
        if (node.x != null && node.y != null) {
          const fg = fgRef.current as unknown as CenterLike | undefined;
          fg?.centerAt(node.x, node.y, 400);
          fg?.zoom?.(2.0, 400);
        }
        return;
      }
      lastClickRef.current = { nodeId: node.id, time: now };
      setSelectedSymbol(node.id);
      setFocusedNodeId(node.id);
    },
    [setSelectedSymbol],
  );

  const handleBackgroundClick = useCallback(() => {
    setSelectedSymbol(null);
  }, [setSelectedSymbol]);

  // Edge weight visualisation — log-scaled width 0.5..3px, opacity 0.3..0.9.
  const maxEdgeWeight = useMemo(() => {
    let max = 1;
    for (const w of edgeWeights.values()) if (w > max) max = w;
    return max;
  }, [edgeWeights]);

  const weightToWidth = useCallback((weight: number, highlighted: boolean): number => {
    const ratio = Math.log(weight + 1) / Math.log(maxEdgeWeight + 1);
    const base = 0.5 + ratio * 2.5;
    return highlighted ? Math.max(2, base + 1.2) : base;
  }, [maxEdgeWeight]);

  const weightToAlpha = useCallback((weight: number): number => {
    const ratio = Math.log(weight + 1) / Math.log(maxEdgeWeight + 1);
    return 0.3 + ratio * 0.6;
  }, [maxEdgeWeight]);

  /**
   * Edge color resolver — delegates alpha handling to `applyEdgeAlpha` so we
   * support rgb/rgba/hsl/hsla format strings (the previous implementation
   * only handled rgba() and silently dropped alpha for everything else).
   *
   * Note on side effects: `applyEdgeAlpha` may set `ctx.globalAlpha` for
   * non-functional color formats (hex, named). react-force-graph's
   * `linkColor` callback runs without ctx access, so we lean on the
   * functional-color path here; pure-hex themes would need a custom canvas
   * render to honour the alpha. In practice the project CSS vars are rgba().
   */
  const linkColor = useCallback(
    (link: GraphLink) => {
      const s = extractNodeId(link.source);
      const t = extractNodeId(link.target);
      const highlighted = interactions.isLinkHighlighted(s, t);
      if (highlighted) return colors.edgeActive;
      const weight = edgeWeights.get(canonicalEdgeKey(s, t)) ?? 1;
      const alpha = weightToAlpha(weight);
      // Pass a no-op context: applyEdgeAlpha only mutates globalAlpha when it
      // can't encode alpha in the color string. For rgba/hsla themes this
      // returns a fully-functional color and never touches the context.
      const fakeCtx = {
        globalAlpha: 1,
      } as unknown as CanvasRenderingContext2D;
      return applyEdgeAlpha(fakeCtx, colors.edge, alpha);
    },
    [interactions, colors, edgeWeights, weightToAlpha],
  );

  const linkWidth = useCallback(
    (link: GraphLink) => {
      const s = extractNodeId(link.source);
      const t = extractNodeId(link.target);
      const highlighted = interactions.isLinkHighlighted(s, t);
      const weight = edgeWeights.get(canonicalEdgeKey(s, t)) ?? 1;
      return weightToWidth(weight, highlighted);
    },
    [interactions, edgeWeights, weightToWidth],
  );

  const fileCount = useMemo(() => {
    const files = new Set<string>();
    for (const n of nodes) {
      if (n.file) files.add(n.file);
    }
    return files.size;
  }, [nodes]);

  const isolatedCount = Math.max(0, nodes.length - connectionCounts.size);

  // World bounds for minimap — derive from nodes' current positions, with a
  // pad to avoid a zero-size bound when all nodes share the same coords.
  const worldBounds = useMemo<MinimapWorldBounds>(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
      return { minX: -200, maxX: 200, minY: -200, maxY: 200 };
    }
    if (maxX - minX < 1) { minX -= 100; maxX += 100; }
    if (maxY - minY < 1) { minY -= 100; maxY += 100; }
    return { minX, maxX, minY, maxY };
  }, [nodes]);

  // Track viewport from react-force-graph (zoomEnd + panEnd).
  const handleZoomChange = useCallback((zoom: { k: number; x: number; y: number }) => {
    const w = containerRef.current?.clientWidth ?? 0;
    const h = containerRef.current?.clientHeight ?? 0;
    // react-force-graph emits screen-translation (x,y) — convert to world
    // coordinate at the centre of the canvas.
    const worldX = (w / 2 - zoom.x) / zoom.k;
    const worldY = (h / 2 - zoom.y) / zoom.k;
    setViewport({ x: worldX, y: worldY, zoom: zoom.k, width: w, height: h });
  }, []);

  const handleMinimapNavigate = useCallback((worldX: number, worldY: number) => {
    const fg = fgRef.current as unknown as CenterLike | undefined;
    fg?.centerAt(worldX, worldY, 400);
  }, []);

  // Search interactions ------------------------------------------------------
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && topMatchId) {
      e.preventDefault();
      setSelectedSymbol(topMatchId);
      setFocusedNodeId(topMatchId);
      animateToNode(topMatchId);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setSearchQuery('');
      searchInputRef.current?.blur();
    }
  }, [topMatchId, setSelectedSymbol, animateToNode]);

  const focusSearch = useCallback(() => {
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, []);

  const handleKeyboardEscape = useCallback(() => {
    if (localGraphMode) {
      setLocalGraphMode(false);
      setLocalGraphCenter(null);
    } else if (searchQuery) {
      setSearchQuery('');
    }
  }, [localGraphMode, searchQuery]);

  // Note: Ctrl/Cmd+K and "/" are handled by `useGraphKeyboard` and dispatch
  // via the canvas wrapper's onKeyDown. Removed the previous duplicate global
  // useEffect to keep a single keyboard-routing path.

  // Wire useGraphKeyboard to the canvas wrapper so Arrow/J/K/L/H/Enter work
  // when the canvas (not the search input) has focus.
  const canvasKeyboard = useGraphKeyboard({
    nodes,
    adjacency: useMemo(() => {
      const map = new Map<string, string[]>();
      for (const [k, v] of interactions.adjacency) map.set(k, Array.from(v));
      return map;
    }, [interactions.adjacency]),
    focusedNodeId,
    onFocus: setFocusedNodeId,
    onSelect: (id) => {
      setSelectedSymbol(id);
      animateToNode(id);
    },
    onSearchFocus: focusSearch,
    onEscape: handleKeyboardEscape,
  });

  // Export PNG --------------------------------------------------------------
  const handleExportPng = useCallback(() => {
    const root = containerRef.current;
    if (!root) {
      setExportStatus({ kind: 'error', message: 'Canvas not ready' });
      window.setTimeout(() => setExportStatus(null), 2400);
      return;
    }
    const canvas = root.querySelector('canvas');
    if (!canvas) {
      setExportStatus({ kind: 'error', message: 'No canvas element found' });
      window.setTimeout(() => setExportStatus(null), 2400);
      return;
    }
    try {
      // `toDataURL` throws on a tainted (cross-origin) canvas. Surface a real
      // user-facing message instead of swallowing the error.
      const dataUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safeName = (vaultId ?? 'vault').replace(/[^A-Za-z0-9_.-]/g, '_');
      a.href = dataUrl;
      a.download = `vault-graph-${safeName}-${timestamp}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setExportStatus({ kind: 'success' });
      window.setTimeout(() => setExportStatus(null), 1800);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[graph-canvas] export failed', err);
      setExportStatus({ kind: 'error', message });
      window.setTimeout(() => setExportStatus(null), 2400);
    }
  }, [vaultId]);

  // Physics preset application.
  const applyPreset = useCallback((preset: keyof typeof PHYSICS_PRESETS) => {
    setPhysicsConfig({ ...PHYSICS_PRESETS[preset] });
    simulation.reheat();
  }, [simulation]);

  const matchCountLabel = searchTrimmed.length === 0
    ? null
    : (searchTotal === 0
        ? t('graph.search.noMatches')
        : t('graph.search.matchCount', { count: searchTotal }));

  return (
    <div
      ref={containerRef}
      className="h-full w-full relative outline-none"
      style={{ background: colors.bg }}
      data-testid="graph-canvas"
      tabIndex={0}
      role="application"
      aria-label={t('graph.a11y.regionLabel')}
      onKeyDown={canvasKeyboard.handlers.onKeyDown}
    >
      {/* Sr-only a11y tree mirroring the graph state. Receives the lifted
          keyboard handlers from the canvas hook above so we don't construct
          two `useGraphKeyboard` instances with diverging local state. */}
      <GraphA11yOverlay
        nodes={nodes}
        links={links}
        selectedNodeId={selectedSymbolId}
        focusedNodeId={focusedNodeId}
        onSelect={(id) => setSelectedSymbol(id)}
        onFocus={(id) => setFocusedNodeId(id)}
        onSearchFocus={focusSearch}
        onEscape={handleKeyboardEscape}
        keyboardHandlers={canvasKeyboard.handlers}
      />

      {/* Search bar — top left */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-2">
        <div className="relative">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={t('graph.search.placeholder', 'Search nodes...')}
            aria-label={t('graph.search.ariaLabel', 'Search nodes')}
            className="w-56 h-8 pl-3 pr-3 rounded-full text-xs backdrop-blur-sm
                       border focus:outline-none focus:border-[var(--color-border-hover)] transition-colors"
            style={{
              background: colors.panelBg,
              borderColor: colors.panelBorder,
              color: colors.textPrimary,
            }}
          />
        </div>
        {matchCountLabel && (
          <span
            className="text-[10px] px-2 py-0.5 rounded-full border backdrop-blur-sm"
            style={{
              background: colors.panelBg,
              borderColor: colors.panelBorder,
              color: searchTotal === 0 ? colors.textTertiary : colors.textSecondary,
            }}
          >
            {matchCountLabel}
          </span>
        )}
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            className="text-[10px] transition-colors"
            style={{ color: colors.textTertiary }}
            onMouseEnter={(e) => (e.currentTarget.style.color = colors.textSecondary)}
            onMouseLeave={(e) => (e.currentTarget.style.color = colors.textTertiary)}
          >
            {t('graph.search.clear', 'Clear')}
          </button>
        )}
      </div>

      {/* Top-right toolbar: export + settings */}
      <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
        <button
          type="button"
          onClick={handleExportPng}
          className="h-8 px-3 rounded-full backdrop-blur-sm border text-[10px] transition-all"
          style={{ background: colors.panelBg, borderColor: colors.panelBorder, color: colors.textTertiary }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = colors.textSecondary;
            e.currentTarget.style.borderColor = colors.nodeBorderHover;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = colors.textTertiary;
            e.currentTarget.style.borderColor = colors.panelBorder;
          }}
          title={t('graph.actions.exportPng', 'Save as PNG')}
        >
          {t('graph.actions.exportPng', 'Save as PNG')}
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowSettings((s) => !s)}
            className="w-8 h-8 rounded-full backdrop-blur-sm border
                       flex items-center justify-center transition-all"
            style={{
              background: colors.panelBg,
              borderColor: colors.panelBorder,
              color: colors.textTertiary,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = colors.textSecondary;
              e.currentTarget.style.borderColor = colors.nodeBorderHover;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = colors.textTertiary;
              e.currentTarget.style.borderColor = colors.panelBorder;
            }}
            title="Display settings"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>

          {/* Settings dropdown */}
          {showSettings && (
            <div className="absolute top-10 right-0 w-64 rounded-xl backdrop-blur-md
                            border shadow-2xl overflow-hidden max-h-[80vh] overflow-y-auto"
                 style={{ background: colors.panelBg, borderColor: colors.panelBorder }}>
              <div className="px-3 py-2.5 border-b" style={{ borderColor: colors.panelBorder }}>
                <div className="text-[10px] uppercase tracking-wider font-medium" style={{ color: colors.textTertiary }}>
                  Display
                </div>
              </div>
              <div className="p-2 space-y-2">
                {/* Orphan nodes */}
                <label className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]">
                  <input
                    type="checkbox"
                    checked={showOrphans}
                    onChange={(e) => setShowOrphans(e.target.checked)}
                    className="w-3 h-3 rounded border bg-transparent accent-[var(--color-accent)]"
                    style={{ borderColor: colors.nodeBorder }}
                  />
                  <span className="text-[11px]" style={{ color: colors.textSecondary }}>Show orphan nodes</span>
                </label>

                {/* Local graph toggle */}
                <button
                  type="button"
                  onClick={() => {
                    if (localGraphMode) {
                      setLocalGraphMode(false);
                      setLocalGraphCenter(null);
                    } else if (selectedSymbolId) {
                      setLocalGraphMode(true);
                      setLocalGraphCenter(selectedSymbolId);
                      animateToNode(selectedSymbolId);
                    }
                  }}
                  disabled={!localGraphMode && !selectedSymbolId}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors text-left
                    ${localGraphMode || selectedSymbolId
                      ? 'hover:bg-[var(--color-surface-hover)] cursor-pointer'
                      : 'opacity-40 cursor-not-allowed'
                    }`}
                >
                  <span className="w-3 h-3 rounded-full border flex items-center justify-center"
                        style={{ borderColor: colors.nodeBorder, background: localGraphMode ? colors.nodeBorderHover : 'transparent' }}>
                    {localGraphMode && <span className="w-1.5 h-1.5 rounded-full" style={{ background: colors.textSecondary }} />}
                  </span>
                  <span className="text-[11px]" style={{ color: colors.textSecondary }}>
                    {localGraphMode ? 'Full Graph' : 'Local Graph'}
                  </span>
                </button>

                {/* Hop depth — only meaningful when local graph mode active */}
                {localGraphMode && (
                  <div className="px-2 py-1">
                    <div className="text-[10px] mb-1" style={{ color: colors.textTertiary }}>
                      {t('graph.local.hopDepth.title')}
                    </div>
                    <div className="flex gap-1" role="radiogroup" aria-label={t('graph.local.hopDepth.title')}>
                      {([1, 2, 3] as const).map((depth) => (
                        <button
                          key={depth}
                          type="button"
                          role="radio"
                          aria-checked={localGraphHopDepth === depth}
                          onClick={() => setLocalGraphHopDepth(depth)}
                          className="flex-1 px-2 py-1 rounded text-[10px] transition-colors"
                          style={{
                            background: localGraphHopDepth === depth ? 'var(--color-surface-hover)' : 'transparent',
                            color: localGraphHopDepth === depth ? colors.textPrimary : colors.textTertiary,
                          }}
                        >
                          {t('graph.local.hopDepth.label', { count: depth })}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Group by */}
                <div className="px-2 py-1">
                  <div className="text-[10px] mb-1" style={{ color: colors.textTertiary }}>Group by</div>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setGroupBy('lang')}
                      className="flex-1 px-2 py-1 rounded text-[10px] transition-colors"
                      style={{
                        background: groupBy === 'lang' ? 'var(--color-surface-hover)' : 'transparent',
                        color: groupBy === 'lang' ? colors.textPrimary : colors.textTertiary,
                      }}
                    >
                      Language
                    </button>
                    <button
                      type="button"
                      onClick={() => setGroupBy('folder')}
                      className="flex-1 px-2 py-1 rounded text-[10px] transition-colors"
                      style={{
                        background: groupBy === 'folder' ? 'var(--color-surface-hover)' : 'transparent',
                        color: groupBy === 'folder' ? colors.textPrimary : colors.textTertiary,
                      }}
                    >
                      Folder
                    </button>
                  </div>
                </div>

                {/* Node size */}
                <div className="px-2 py-1">
                  <div className="text-[10px] mb-1" style={{ color: colors.textTertiary }}>Node size</div>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setNodeSizeMode('connections')}
                      className="flex-1 px-2 py-1 rounded text-[10px] transition-colors"
                      style={{
                        background: nodeSizeMode === 'connections' ? 'var(--color-surface-hover)' : 'transparent',
                        color: nodeSizeMode === 'connections' ? colors.textPrimary : colors.textTertiary,
                      }}
                    >
                      Connections
                    </button>
                    <button
                      type="button"
                      onClick={() => setNodeSizeMode('uniform')}
                      className="flex-1 px-2 py-1 rounded text-[10px] transition-colors"
                      style={{
                        background: nodeSizeMode === 'uniform' ? 'var(--color-surface-hover)' : 'transparent',
                        color: nodeSizeMode === 'uniform' ? colors.textPrimary : colors.textTertiary,
                      }}
                    >
                      Uniform
                    </button>
                  </div>
                </div>

                {/* Kind filter (collapsible) */}
                <div className="px-2 py-1">
                  <button
                    type="button"
                    onClick={() => setShowKindFilter((s) => !s)}
                    className="w-full flex items-center justify-between text-[10px]"
                    style={{ color: colors.textTertiary }}
                  >
                    <span>{t('graph.filters.kinds.title')}</span>
                    <span>{showKindFilter ? '−' : '+'}</span>
                  </button>
                  {showKindFilter && (
                    <div className="mt-1.5 space-y-1">
                      <div className="flex justify-between text-[10px]">
                        <button
                          type="button"
                          onClick={() => setGraphKindsAll(true)}
                          className="underline-offset-2 hover:underline"
                          style={{ color: colors.textSecondary }}
                        >
                          {t('graph.filters.kinds.selectAll')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setGraphKindsAll(false)}
                          className="underline-offset-2 hover:underline"
                          style={{ color: colors.textSecondary }}
                        >
                          {t('graph.filters.kinds.clearAll')}
                        </button>
                      </div>
                      {ALL_SYMBOL_KINDS.map((kind) => {
                        const style = KIND_STYLE_MAP[kind] ?? getKindStyle(kind);
                        return (
                          <label
                            key={kind}
                            className="flex items-center gap-2 px-1 py-1 rounded-md cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
                          >
                            <input
                              type="checkbox"
                              checked={graphKindsFilter[kind] !== false}
                              onChange={() => toggleGraphKind(kind)}
                              className="w-3 h-3 rounded border bg-transparent accent-[var(--color-accent)]"
                              style={{ borderColor: colors.nodeBorder }}
                            />
                            <span
                              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                              style={{ background: style.color }}
                              aria-hidden
                            />
                            <span className="text-[11px]" style={{ color: colors.textSecondary }}>
                              {t(`filter.kind.${kind}`, style.label)}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Edge weight legend */}
                <div className="px-2 py-1">
                  <div className="text-[10px] mb-1" style={{ color: colors.textTertiary }}>
                    {t('graph.edges.legendTitle')}
                  </div>
                  <div className="flex items-center gap-2">
                    <svg width="80" height="10" viewBox="0 0 80 10" aria-hidden>
                      <line x1="0" y1="5" x2="20" y2="5" stroke={colors.edge} strokeWidth="0.5" />
                      <line x1="20" y1="5" x2="50" y2="5" stroke={colors.edge} strokeWidth="1.5" />
                      <line x1="50" y1="5" x2="80" y2="5" stroke={colors.edge} strokeWidth="3" />
                    </svg>
                    <span className="text-[10px]" style={{ color: colors.textTertiary }}>
                      {t('graph.edges.legendHint', { max: maxEdgeWeight })}
                    </span>
                  </div>
                </div>

                {/* Advanced physics */}
                <div className="px-2 py-1">
                  <button
                    type="button"
                    onClick={() => setShowAdvancedPhysics((s) => !s)}
                    className="w-full flex items-center justify-between text-[10px]"
                    style={{ color: colors.textTertiary }}
                  >
                    <span>{t('graph.physics.title')}</span>
                    <span>{showAdvancedPhysics ? '−' : '+'}</span>
                  </button>
                  {showAdvancedPhysics && (
                    <div className="mt-2 space-y-2">
                      <div className="flex gap-1">
                        {(['sparse', 'balanced', 'dense'] as const).map((p) => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => applyPreset(p)}
                            className="flex-1 px-1.5 py-1 rounded text-[10px] transition-colors hover:bg-[var(--color-surface-hover)]"
                            style={{
                              border: `1px solid ${colors.panelBorder}`,
                              color: colors.textSecondary,
                            }}
                          >
                            {t(`graph.physics.preset.${p}`)}
                          </button>
                        ))}
                      </div>

                      <PhysicsSlider
                        label={t('graph.physics.linkDistance')}
                        value={physicsConfig.linkDistance}
                        min={50}
                        max={300}
                        onChange={(v) => {
                          setPhysicsConfig((c) => ({ ...c, linkDistance: v }));
                          simulation.reheat();
                        }}
                        labelColor={colors.textTertiary}
                      />
                      <PhysicsSlider
                        label={t('graph.physics.charge')}
                        value={physicsConfig.chargeStrength}
                        min={-300}
                        max={-20}
                        onChange={(v) => {
                          setPhysicsConfig((c) => ({ ...c, chargeStrength: v }));
                          simulation.reheat();
                        }}
                        labelColor={colors.textTertiary}
                      />
                      <PhysicsSlider
                        label={t('graph.physics.collide')}
                        value={physicsConfig.collideRadius}
                        min={4}
                        max={20}
                        onChange={(v) => {
                          setPhysicsConfig((c) => ({ ...c, collideRadius: v }));
                          simulation.reheat();
                        }}
                        labelColor={colors.textTertiary}
                      />

                      <button
                        type="button"
                        onClick={() => applyPreset('balanced')}
                        className="w-full text-[10px] py-1 rounded transition-colors hover:bg-[var(--color-surface-hover)]"
                        style={{ color: colors.textTertiary }}
                      >
                        {t('graph.physics.reset')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Force Graph */}
      <ForceGraph2D<GraphNode, GraphLink>
        ref={fgRef}
        graphData={graphData}
        backgroundColor="transparent"
        warmupTicks={100}
        cooldownTicks={50}
        nodeRelSize={4}
        nodeVal="val"
        nodeCanvasObject={nodeCanvasObject}
        nodeCanvasObjectMode={() => 'replace'}
        linkColor={linkColor}
        linkWidth={linkWidth}
        linkDirectionalArrowLength={6}
        linkDirectionalArrowRelPos={1}
        linkDirectionalArrowColor={() => colors.edgeArrow}
        onZoom={handleZoomChange}
        onZoomEnd={handleZoomChange}
        onNodeHover={(node) => {
          const n = node ? (node as GraphNode) : null;
          interactions.setHoverNode(n?.id ?? null);
          setTooltipNode(n);
        }}
        onNodeClick={(node) => handleNodeClick(node as GraphNode)}
        onBackgroundClick={handleBackgroundClick}
        enableNodeDrag={true}
        enableZoomInteraction={true}
        enablePanInteraction={true}
        autoPauseRedraw={searchTrimmed.length === 0}
      />

      {/* Truncation notice */}
      {truncated && (
        <div
          className="absolute top-14 left-4 z-10 px-2 py-1 rounded text-[10px] backdrop-blur-sm border pointer-events-none"
          style={{ background: colors.panelBg, borderColor: colors.panelBorder, color: colors.textSecondary }}
        >
          {t('graph.truncated', { max: DEFAULT_SIM_CONFIG.maxNodes })}
        </div>
      )}

      {/* Stats — bottom left */}
      <div className="absolute bottom-4 left-4 z-10 pointer-events-none select-none">
        <div className="text-[10px] leading-relaxed" style={{ color: colors.textTertiary }}>
          <div>
            {nodes.length} {nodes.length === 1 ? 'node' : 'nodes'} · {links.length}{' '}
            {links.length === 1 ? 'link' : 'links'}
          </div>
          {fileCount > 0 && <div>{fileCount} files</div>}
          {isolatedCount > 0 && <div>{isolatedCount} isolated</div>}
          {localGraphMode && <div style={{ color: colors.textSecondary }}>Local view</div>}
          {simulation.running && <div style={{ color: colors.textTertiary }}>sim v{simulation.version}</div>}
        </div>
      </div>

      {/* Minimap — bottom right (above the zoom controls) */}
      {nodes.length > 0 && viewport.width > 0 && viewport.height > 0 && (
        <div className="absolute bottom-16 right-4 z-10">
          <GraphMinimap
            nodes={nodes}
            links={links}
            viewport={viewport}
            worldBounds={worldBounds}
            onNavigate={handleMinimapNavigate}
            selectedNodeId={selectedSymbolId}
          />
        </div>
      )}

      {/* Zoom controls — bottom right */}
      <div className="absolute bottom-4 right-4 z-10 flex items-center gap-1">
        <button
          type="button"
          onClick={() => fgRef.current?.zoom(0.8, 400)}
          className="w-8 h-7 rounded-full backdrop-blur-sm border flex items-center justify-center text-[10px] transition-all"
          style={{ background: colors.panelBg, borderColor: colors.panelBorder, color: colors.textTertiary }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = colors.textSecondary;
            e.currentTarget.style.borderColor = colors.nodeBorderHover;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = colors.textTertiary;
            e.currentTarget.style.borderColor = colors.panelBorder;
          }}
          title="Zoom out"
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          onClick={() => fgRef.current?.zoom(1.2, 400)}
          className="w-8 h-7 rounded-full backdrop-blur-sm border flex items-center justify-center text-[10px] transition-all"
          style={{ background: colors.panelBg, borderColor: colors.panelBorder, color: colors.textTertiary }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = colors.textSecondary;
            e.currentTarget.style.borderColor = colors.nodeBorderHover;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = colors.textTertiary;
            e.currentTarget.style.borderColor = colors.panelBorder;
          }}
          title="Zoom in"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => fgRef.current?.zoomToFit(400, 20)}
          className="px-2 h-7 rounded-full backdrop-blur-sm border text-[10px] transition-all"
          style={{ background: colors.panelBg, borderColor: colors.panelBorder, color: colors.textTertiary }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = colors.textSecondary;
            e.currentTarget.style.borderColor = colors.nodeBorderHover;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = colors.textTertiary;
            e.currentTarget.style.borderColor = colors.panelBorder;
          }}
        >
          Fit
        </button>
      </div>

      {/* Export status toast (success or error). */}
      {exportStatus && (
        <div
          className="absolute top-14 right-4 z-20 px-3 py-1.5 rounded-md text-[11px] border backdrop-blur-sm max-w-xs"
          role={exportStatus.kind === 'error' ? 'alert' : 'status'}
          style={{
            background: colors.panelBg,
            borderColor: colors.panelBorder,
            color: exportStatus.kind === 'error' ? '#ff6b6b' : colors.textPrimary,
          }}
        >
          {exportStatus.kind === 'success'
            ? t('graph.actions.exportSuccess')
            : t('graph.actions.exportError', { defaultValue: 'Export failed: {{message}}', message: exportStatus.message })}
        </div>
      )}

      {/* Node tooltip */}
      {tooltipNode && (
        <GraphNodeTooltip
          node={tooltipNode}
          x={mousePos.x}
          y={mousePos.y}
          connectionCount={connectionCounts.get(tooltipNode.id) ?? 0}
        />
      )}

      {/* Node detail overlay */}
      <GraphNodeOverlay nodeId={selectedSymbolId} onClose={handleBackgroundClick} />
    </div>
  );
}

interface PhysicsSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  labelColor: string;
}

function PhysicsSlider({ label, value, min, max, onChange, labelColor }: PhysicsSliderProps) {
  return (
    <label className="block">
      <div className="flex items-center justify-between text-[10px]" style={{ color: labelColor }}>
        <span>{label}</span>
        <span>{Math.round(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--color-accent)]"
      />
    </label>
  );
}
