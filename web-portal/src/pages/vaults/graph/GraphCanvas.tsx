import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { ForceGraphMethods } from 'react-force-graph-2d';

import {
  useVaultStore,
  type CanvasJson,
} from '../../../stores/vault-store';
import { useTheme } from '../../../hooks/useTheme';
import { useGraphInteractions, extractNodeId } from './useGraphInteractions';
import { parseNodeText } from './node-style';
import { GraphNodeOverlay } from './GraphNodeOverlay';
import { GraphNodeTooltip } from './GraphNodeTooltip';
import type { GraphNode, GraphLink } from './graph-types';

interface Props {
  graph: CanvasJson;
}

const FOLDER_PALETTE = [
  '#8B7AB8', '#5B8DB8', '#7AB88B', '#B8A87A', '#B87A9B', '#888888',
  '#7A8BB8', '#B87A7A', '#7AB8B8', '#B8B87A',
];

function buildGraphData(
  graph: CanvasJson,
  showOrphans: boolean,
  groupBy: 'lang' | 'folder',
  nodeSizeMode: 'connections' | 'uniform',
  localGraphMode: boolean,
  localGraphCenter: string | null,
) {
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

  const nodes: GraphNode[] = graph.nodes
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
    });

  const nodeIds = new Set(nodes.map((n) => n.id));
  const links: GraphLink[] = graph.edges
    .filter((e) => nodeIds.has(e.fromNode) && nodeIds.has(e.toNode))
    .map((e) => ({
      source: e.fromNode,
      target: e.toNode,
      label: e.label,
    }));

  if (localGraphMode && localGraphCenter) {
    const neighborIds = new Set<string>([localGraphCenter]);
    for (const link of links) {
      const s = extractNodeId(link.source);
      const t = extractNodeId(link.target);
      if (s === localGraphCenter) neighborIds.add(t);
      if (t === localGraphCenter) neighborIds.add(s);
    }
    const filteredNodes = nodes.filter((n) => neighborIds.has(n.id));
    const filteredNodeIds = new Set(filteredNodes.map((n) => n.id));
    const filteredLinks = links.filter((l) => {
      const s = extractNodeId(l.source);
      const t = extractNodeId(l.target);
      return filteredNodeIds.has(s) && filteredNodeIds.has(t);
    });
    return { nodes: filteredNodes, links: filteredLinks, connectionCounts };
  }

  return { nodes, links, connectionCounts };
}

function readCssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
}

function useGraphColors() {
  const { theme } = useTheme();
  return useMemo(() => {
    const isDark = theme === 'dark';
    return {
      bg: readCssVar('--graph-bg', isDark ? '#0a0a0f' : '#fafafa'),
      edge: readCssVar('--graph-edge', isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)'),
      edgeActive: readCssVar('--graph-edge-active', isDark ? '#00e5ff' : '#0891b2'),
      edgeArrow: readCssVar('--graph-edge', isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)'),
      nodeBorder: readCssVar('--graph-node-border', isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'),
      nodeBorderHover: readCssVar('--graph-node-border-hover', isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)'),
      nodeSelectedRing: readCssVar('--graph-node-selected-ring', isDark ? '#00e5ff' : '#0891b2'),
      label: readCssVar('--graph-label', isDark ? '#a0a0b0' : '#4a4a5a'),
      labelDetail: readCssVar('--graph-label-detail', isDark ? '#6a6a7a' : '#8a8a9a'),
      panelBg: readCssVar('--graph-panel-bg', isDark ? 'rgba(16,16,22,0.92)' : 'rgba(255,255,255,0.95)'),
      panelBorder: readCssVar('--graph-panel-border', isDark ? '#1f1f2f' : 'rgba(0,0,0,0.12)'),
      textPrimary: readCssVar('--color-text', isDark ? '#e8e8ed' : '#1a1a2e'),
      textSecondary: readCssVar('--color-text-secondary', isDark ? '#a0a0b0' : '#4a4a5a'),
      textTertiary: readCssVar('--color-text-tertiary', isDark ? '#6a6a7a' : '#8a8a9a'),
    };
  }, [theme]);
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
  colors: ReturnType<typeof useGraphColors>,
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
  colors: ReturnType<typeof useGraphColors>,
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

export default function GraphCanvas({ graph }: Props) {
  const selectedSymbolId = useVaultStore((s) => s.selectedSymbolId);
  const setSelectedSymbol = useVaultStore((s) => s.setSelectedSymbol);
  const colors = useGraphColors();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<ForceGraphMethods<any, any> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasAutoFitRef = useRef(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showOrphans, setShowOrphans] = useState(true);
  const [groupBy, setGroupBy] = useState<'lang' | 'folder'>('lang');
  const [nodeSizeMode, setNodeSizeMode] = useState<'connections' | 'uniform'>('connections');
  const [localGraphMode, setLocalGraphMode] = useState(false);
  const [localGraphCenter, setLocalGraphCenter] = useState<string | null>(null);
  const [tooltipNode, setTooltipNode] = useState<GraphNode | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const lastClickRef = useRef<{ nodeId: string; time: number } | null>(null);

  const searchLower = searchQuery.trim().toLowerCase();

  const { nodes, links, connectionCounts } = useMemo(
    () => buildGraphData(graph, showOrphans, groupBy, nodeSizeMode, localGraphMode, localGraphCenter),
    [graph, showOrphans, groupBy, nodeSizeMode, localGraphMode, localGraphCenter],
  );

  const matchingIds = useMemo(() => {
    if (!searchLower) return new Set<string>();
    return new Set(
      nodes.filter((n) => n.label.toLowerCase().includes(searchLower)).map((n) => n.id),
    );
  }, [nodes, searchLower]);

  const interactions = useGraphInteractions({ links });

  // Auto-fit on first meaningful data
  useEffect(() => {
    if (nodes.length > 0 && !hasAutoFitRef.current) {
      hasAutoFitRef.current = true;
      const timer = setTimeout(() => {
        fgRef.current?.zoomToFit(600, 20);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [nodes]);

  // Reset auto-fit when graph source changes
  useEffect(() => {
    hasAutoFitRef.current = false;
  }, [graph]);

  // Physics tuning — only when graph prop changes, not every nodes/links memo change
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const linkForce = fg.d3Force('link') as any;
    if (linkForce && typeof linkForce.distance === 'function') {
      linkForce.distance(100);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chargeForce = fg.d3Force('charge') as any;
    if (chargeForce && typeof chargeForce.strength === 'function') {
      chargeForce.strength(-100);
    }
    fg.d3ReheatSimulation();
  }, [graph]);

  // Escape to exit local graph mode
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && localGraphMode) {
        setLocalGraphMode(false);
        setLocalGraphCenter(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [localGraphMode]);

  // Track mouse position for tooltip
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

  const nodeCanvasObject = useCallback(
    (node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const highlighted = interactions.isHighlighted(node.id);
      const opacity = interactions.highlightedOpacity(highlighted);
      const isSelected = node.id === selectedSymbolId;
      const isHovered = node.id === interactions.hoverNode;
      const isMatching = matchingIds.has(node.id);

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
    [interactions, selectedSymbolId, matchingIds, colors],
  );

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      const now = Date.now();
      if (lastClickRef.current?.nodeId === node.id && now - lastClickRef.current.time < 300) {
        // Double-click detected
        setLocalGraphMode(true);
        setLocalGraphCenter(node.id);
        lastClickRef.current = null;
        return;
      }
      lastClickRef.current = { nodeId: node.id, time: now };
      setSelectedSymbol(node.id);
    },
    [setSelectedSymbol],
  );

  const handleBackgroundClick = useCallback(() => {
    setSelectedSymbol(null);
  }, [setSelectedSymbol]);

  const linkColor = useCallback(
    (link: GraphLink) => {
      const s = extractNodeId(link.source);
      const t = extractNodeId(link.target);
      const highlighted = interactions.isLinkHighlighted(s, t);
      return highlighted ? colors.edgeActive : colors.edge;
    },
    [interactions, colors],
  );

  const linkWidth = useCallback(
    (link: GraphLink) => {
      const s = extractNodeId(link.source);
      const t = extractNodeId(link.target);
      const highlighted = interactions.isLinkHighlighted(s, t);
      return highlighted ? 2.0 : 0.8;
    },
    [interactions],
  );

  const fileCount = useMemo(() => {
    const files = new Set<string>();
    for (const n of nodes) {
      if (n.file) files.add(n.file);
    }
    return files.size;
  }, [nodes]);

  const isolatedCount = Math.max(0, nodes.length - connectionCounts.size);

  return (
    <div ref={containerRef} className="h-full w-full relative" style={{ background: colors.bg }} data-testid="graph-canvas">
      {/* Search bar — top left */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-2">
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search nodes..."
            className="w-56 h-8 pl-3 pr-3 rounded-full text-xs backdrop-blur-sm
                       border focus:outline-none focus:border-[var(--color-border-hover)] transition-colors"
            style={{
              background: colors.panelBg,
              borderColor: colors.panelBorder,
              color: colors.textPrimary,
            }}
          />
        </div>
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            className="text-[10px] transition-colors"
            style={{ color: colors.textTertiary }}
            onMouseEnter={(e) => (e.currentTarget.style.color = colors.textSecondary)}
            onMouseLeave={(e) => (e.currentTarget.style.color = colors.textTertiary)}
          >
            Clear
          </button>
        )}
      </div>

      {/* Settings toggle — top right */}
      <div className="absolute top-4 right-4 z-10">
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
          <div className="absolute top-10 right-0 w-52 rounded-xl backdrop-blur-md
                          border shadow-2xl overflow-hidden"
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
            </div>
          </div>
        )}
      </div>

      {/* Force Graph */}
      <ForceGraph2D
        ref={fgRef}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        graphData={{ nodes, links: links as any[] }}
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
        autoPauseRedraw={searchLower.length === 0}
      />

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
        </div>
      </div>

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
