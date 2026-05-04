import { useCallback, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { ForceGraphMethods } from 'react-force-graph-2d';

import {
  useVaultStore,
  type CanvasJson,
} from '../../../stores/vault-store';
import { useGraphInteractions } from './useGraphInteractions';
import { getKindStyle, parseNodeText } from './node-style';

interface Props {
  graph: CanvasJson;
}

interface GraphNode {
  id: string;
  label: string;
  kind: string | null;
  color: string;
  val: number;
  file: string | null;
  line: number | null;
  x?: number;
  y?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GraphLink = any;

function extractNodeId(raw: string | { id: string } | unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && 'id' in raw) return (raw as { id: string }).id;
  return String(raw);
}

function buildGraphData(graph: CanvasJson) {
  // Compute connection counts first (on full set)
  const connectionCounts = new Map<string, number>();
  for (const e of graph.edges) {
    connectionCounts.set(e.fromNode, (connectionCounts.get(e.fromNode) ?? 0) + 1);
    connectionCounts.set(e.toNode, (connectionCounts.get(e.toNode) ?? 0) + 1);
  }

  const nodes: GraphNode[] = graph.nodes.map((n) => {
    const parsed = parseNodeText(n.text);
    const kind = n.kind ?? parsed.kind;
    const style = getKindStyle(kind);
    const connCount = connectionCounts.get(n.id) ?? 0;

    return {
      id: n.id,
      label: parsed.name || n.text.split('/').pop() || n.id,
      kind,
      color: n.color ?? style.color,
      val: Math.max(connCount, 1),
      file: n.file ?? parsed.file ?? null,
      line: parsed.line ?? null,
    };
  });

  const links: GraphLink[] = graph.edges.map((e) => ({
    source: e.fromNode,
    target: e.toNode,
    label: e.label,
  }));

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
  ctx.arc(x, y, radius + 4, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.2;
  ctx.fill();
  ctx.globalAlpha = opacity;
}

function drawNodeCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
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
  ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255,255,255,0.8)';
  ctx.lineWidth = isSelected ? 2.0 / globalScale : 1.5 / globalScale;
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
  const fontSize = Math.max(10 / globalScale, 5);
  ctx.font = `400 ${fontSize}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#a0a0a0';
  ctx.globalAlpha = opacity;

  const truncated = node.label.length > 22 ? node.label.slice(0, 20) + '…' : node.label;
  ctx.fillText(truncated, x, y + radius + 3 / globalScale);

  // File:line on large zoom
  if (globalScale > 2.5 && node.file) {
    const fileName = node.file.split('/').pop() ?? node.file;
    const detailFontSize = Math.max(8 / globalScale, 4);
    ctx.font = `400 ${detailFontSize}px ui-monospace, SFMono-Regular, monospace`;
    ctx.fillStyle = '#666666';
    ctx.fillText(
      `${fileName}${node.line ? ':' + node.line : ''}`,
      x,
      y + radius + 3 / globalScale + fontSize + 1,
    );
  }
}

function nodeCanvasObjectFn(
  interactions: ReturnType<typeof useGraphInteractions>,
  selectedSymbolId: string | null,
) {
  return (node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const highlighted = interactions.isHighlighted(node.id);
    const opacity = interactions.highlightedOpacity(highlighted);
    const isSelected = node.id === selectedSymbolId;
    const isHovered = node.id === interactions.hoverNode;

    // Base radius from val (connection count)
    const baseRadius = Math.sqrt(node.val) * 3 + 4;
    const x = node.x ?? 0;
    const y = node.y ?? 0;

    ctx.save();
    ctx.globalAlpha = opacity;

    if (isSelected) {
      drawNodeGlow(ctx, x, y, baseRadius, node.color, opacity);
    }

    drawNodeCircle(ctx, x, y, baseRadius, node.color);

    if (isHovered || isSelected) {
      drawNodeBorder(ctx, x, y, baseRadius, globalScale, isSelected);
    }

    const showLabel = globalScale > 0.8 || baseRadius > 8;
    if (showLabel && highlighted) {
      drawNodeLabel(ctx, node, x, y, baseRadius, globalScale, opacity);
    }

    ctx.restore();
  };
}

export default function GraphCanvas({ graph }: Props) {
  const selectedSymbolId = useVaultStore((s) => s.selectedSymbolId);
  const setSelectedSymbol = useVaultStore((s) => s.setSelectedSymbol);

  const fgRef = useRef<ForceGraphMethods<any, any> | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState('');

  const { nodes, links, connectionCounts } = useMemo(
    () => buildGraphData(graph),
    [graph],
  );

  const interactions = useGraphInteractions({ links });

  const nodeCanvasObject = useMemo(
    () => nodeCanvasObjectFn(interactions, selectedSymbolId),
    [interactions, selectedSymbolId],
  );

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      setSelectedSymbol(node.id);
      const fg = fgRef.current;
      if (fg) {
        fg.centerAt(node.x ?? 0, node.y ?? 0, 400);
        fg.zoom(2.5, 400);
      }
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
    <div className="h-full w-full relative" style={{ background: '#0d0d0d' }} data-testid="graph-canvas">
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
      </div>

      {/* Force Graph */}
      <ForceGraph2D
        ref={fgRef}
        graphData={{ nodes, links }}
        backgroundColor="transparent"
        warmupTicks={60}
        cooldownTicks={30}
        nodeRelSize={1}
        nodeVal="val"
        nodeCanvasObject={nodeCanvasObject}
        nodeCanvasObjectMode={() => 'replace'}
        linkColor={linkColor}
        linkWidth={linkWidth}
        linkDirectionalArrowLength={3}
        linkDirectionalArrowRelPos={1}
        linkDirectionalArrowColor={() => 'rgba(51,51,51,0.3)'}
        onNodeHover={(node) =>
          interactions.setHoverNode(node ? (node as GraphNode).id : null)
        }
        onNodeClick={(node) => handleNodeClick(node as GraphNode)}
        onBackgroundClick={handleBackgroundClick}
        enableNodeDrag={true}
        enableZoomInteraction={true}
        enablePanInteraction={true}
        autoPauseRedraw={false}
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
    </div>
  );
}
