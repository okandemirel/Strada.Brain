import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { ForceGraphMethods } from 'react-force-graph-2d';

import {
  useVaultStore,
  type CanvasJson,
} from '../../../stores/vault-store';
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
) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255,255,255,0.6)';
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
) {
  const fontSize = Math.max(12 / globalScale, 6);
  ctx.font = `400 ${fontSize}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#a0a0a0';
  ctx.globalAlpha = opacity;

  const truncated = node.label.length > 24 ? node.label.slice(0, 22) + '…' : node.label;
  ctx.fillText(truncated, x, y + radius + 3 / globalScale);

  if (globalScale > 2.5 && node.file) {
    const fileName = node.file.split('/').pop() ?? node.file;
    const detailFontSize = Math.max(8 / globalScale, 4);
    ctx.font = `400 ${detailFontSize}px ui-monospace, SFMono-Regular, monospace`;
    ctx.fillStyle = '#555555';
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<ForceGraphMethods<any, any> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

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

  // Physics tuning
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
  }, [nodes, links]);

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
        drawNodeBorder(ctx, x, y, baseRadius, globalScale, isSelected);
      }

      const showLabel = globalScale > 0.5 || baseRadius > 6;
      if (showLabel) {
        drawNodeLabel(ctx, node, x, y, baseRadius, globalScale, opacity);
      }

      ctx.restore();
    },
    [interactions, selectedSymbolId, matchingIds],
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
      return highlighted ? 'rgba(148, 163, 184, 0.45)' : 'rgba(51, 51, 51, 0.25)';
    },
    [interactions],
  );

  const linkWidth = useCallback(
    (link: GraphLink) => {
      const s = extractNodeId(link.source);
      const t = extractNodeId(link.target);
      const highlighted = interactions.isLinkHighlighted(s, t);
      return highlighted ? 1.2 : 0.4;
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
    <div ref={containerRef} className="h-full w-full relative" style={{ background: '#0d0d0d' }} data-testid="graph-canvas">
      {/* Search bar — top left */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-2">
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search nodes..."
            className="w-56 h-8 pl-3 pr-3 rounded-full text-xs bg-black/40 backdrop-blur-sm
                       border border-white/10 text-white placeholder:text-white/30
                       focus:outline-none focus:border-white/30 transition-colors"
          />
        </div>
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            className="text-[10px] text-white/40 hover:text-white/70 transition-colors"
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
          className="w-8 h-8 rounded-full bg-black/40 backdrop-blur-sm border border-white/10
                     flex items-center justify-center text-white/40 hover:text-white/70
                     hover:border-white/20 transition-all"
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
          <div className="absolute top-10 right-0 w-52 rounded-xl bg-[#1a1a1a]/95 backdrop-blur-md
                          border border-white/10 shadow-2xl overflow-hidden">
            <div className="px-3 py-2.5 border-b border-white/5">
              <div className="text-[10px] uppercase tracking-wider text-white/20 font-medium">
                Display
              </div>
            </div>
            <div className="p-2 space-y-2">
              {/* Orphan nodes */}
              <label className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/5 cursor-pointer transition-colors">
                <input
                  type="checkbox"
                  checked={showOrphans}
                  onChange={(e) => setShowOrphans(e.target.checked)}
                  className="w-3 h-3 rounded border-white/20 bg-transparent accent-white"
                />
                <span className="text-[11px] text-white/50">Show orphan nodes</span>
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
                    ? 'hover:bg-white/5 cursor-pointer'
                    : 'opacity-40 cursor-not-allowed'
                  }`}
              >
                <span className={`w-3 h-3 rounded-full border border-white/20 flex items-center justify-center
                  ${localGraphMode ? 'bg-white/20' : 'bg-transparent'}`}>
                  {localGraphMode && <span className="w-1.5 h-1.5 rounded-full bg-white/70" />}
                </span>
                <span className="text-[11px] text-white/50">
                  {localGraphMode ? 'Full Graph' : 'Local Graph'}
                </span>
              </button>

              {/* Group by */}
              <div className="px-2 py-1">
                <div className="text-[10px] text-white/30 mb-1">Group by</div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => setGroupBy('lang')}
                    className={`flex-1 px-2 py-1 rounded text-[10px] transition-colors ${
                      groupBy === 'lang'
                        ? 'bg-white/10 text-white/70'
                        : 'text-white/30 hover:bg-white/5 hover:text-white/50'
                    }`}
                  >
                    Language
                  </button>
                  <button
                    type="button"
                    onClick={() => setGroupBy('folder')}
                    className={`flex-1 px-2 py-1 rounded text-[10px] transition-colors ${
                      groupBy === 'folder'
                        ? 'bg-white/10 text-white/70'
                        : 'text-white/30 hover:bg-white/5 hover:text-white/50'
                    }`}
                  >
                    Folder
                  </button>
                </div>
              </div>

              {/* Node size */}
              <div className="px-2 py-1">
                <div className="text-[10px] text-white/30 mb-1">Node size</div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => setNodeSizeMode('connections')}
                    className={`flex-1 px-2 py-1 rounded text-[10px] transition-colors ${
                      nodeSizeMode === 'connections'
                        ? 'bg-white/10 text-white/70'
                        : 'text-white/30 hover:bg-white/5 hover:text-white/50'
                    }`}
                  >
                    Connections
                  </button>
                  <button
                    type="button"
                    onClick={() => setNodeSizeMode('uniform')}
                    className={`flex-1 px-2 py-1 rounded text-[10px] transition-colors ${
                      nodeSizeMode === 'uniform'
                        ? 'bg-white/10 text-white/70'
                        : 'text-white/30 hover:bg-white/5 hover:text-white/50'
                    }`}
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
        warmupTicks={60}
        cooldownTicks={30}
        nodeRelSize={4}
        nodeVal="val"
        nodeCanvasObject={nodeCanvasObject}
        nodeCanvasObjectMode={() => 'replace'}
        linkColor={linkColor}
        linkWidth={linkWidth}
        linkDirectionalArrowLength={3}
        linkDirectionalArrowRelPos={1}
        linkDirectionalArrowColor={() => 'rgba(51,51,51,0.3)'}
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
        <div className="text-[10px] text-white/30 leading-relaxed">
          <div>
            {nodes.length} {nodes.length === 1 ? 'node' : 'nodes'} · {links.length}{' '}
            {links.length === 1 ? 'link' : 'links'}
          </div>
          {fileCount > 0 && <div>{fileCount} files</div>}
          {isolatedCount > 0 && <div>{isolatedCount} isolated</div>}
          {localGraphMode && <div className="text-white/50">Local view</div>}
        </div>
      </div>

      {/* Zoom controls — bottom right */}
      <div className="absolute bottom-4 right-4 z-10 flex items-center gap-1">
        <button
          type="button"
          onClick={() => fgRef.current?.zoomToFit(400)}
          className="px-2 h-7 rounded-full bg-black/40 backdrop-blur-sm border border-white/10
                     text-[10px] text-white/40 hover:text-white/70 hover:border-white/20
                     transition-all"
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
