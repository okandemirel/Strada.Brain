import { useCallback, useMemo, useRef } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { ForceGraphMethods } from 'react-force-graph-2d';

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';

import {
  useVaultStore,
  type CanvasJson,
} from '../../../stores/vault-store';
import { GraphFilterPanel } from './GraphFilterPanel';
import { GraphDetailPanel, type GraphDetailTarget } from './GraphDetailPanel';
import { GraphStatsOverlay } from './GraphStatsOverlay';
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

// react-force-graph-2d mutates link source/target into node references at runtime.
// We keep the initial shape as strings but accept any at the boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GraphLink = any;

function extractNodeId(raw: string | { id: string } | unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && 'id' in raw) return (raw as { id: string }).id;
  return String(raw);
}

function buildGraphData(
  graph: CanvasJson,
  filters: { kinds: Record<string, boolean>; search: string; fileFilter: string },
) {
  const searchLower = filters.search.trim().toLowerCase();
  const fileLower = filters.fileFilter.trim().toLowerCase();

  // Compute connection counts first (on full set)
  const connectionCounts = new Map<string, number>();
  for (const e of graph.edges) {
    connectionCounts.set(e.fromNode, (connectionCounts.get(e.fromNode) ?? 0) + 1);
    connectionCounts.set(e.toNode, (connectionCounts.get(e.toNode) ?? 0) + 1);
  }

  const enabledKinds = filters.kinds;
  const nodes: GraphNode[] = [];
  for (const n of graph.nodes) {
    const parsed = parseNodeText(n.text);
    const kind = n.kind ?? parsed.kind;
    const labelLower = parsed.name.toLowerCase();
    const fileStr = (n.file ?? parsed.file ?? '').toLowerCase();

    const passKind = kind ? (enabledKinds as Record<string, boolean>)[kind] ?? true : true;
    const passSearch = !searchLower || labelLower.includes(searchLower);
    const passFile = !fileLower || fileStr.includes(fileLower);
    if (!passKind || !passSearch || !passFile) continue;

    const style = getKindStyle(kind);
    const connCount = connectionCounts.get(n.id) ?? 0;

    nodes.push({
      id: n.id,
      label: parsed.name,
      kind,
      color: style.color,
      val: Math.max(connCount, 1),
      file: parsed.file ?? null,
      line: parsed.line ?? null,
    });
  }

  const visibleIds = new Set(nodes.map((n) => n.id));
  const links: GraphLink[] = graph.edges
    .filter((e) => visibleIds.has(e.fromNode) && visibleIds.has(e.toNode))
    .map((e) => ({
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
  ctx.font = `500 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#e2e8f0';
  ctx.globalAlpha = opacity;

  const truncated = node.label.length > 22 ? node.label.slice(0, 20) + '…' : node.label;
  ctx.fillText(truncated, x, y + radius + 3 / globalScale);

  // File:line on large zoom
  if (globalScale > 2.5 && node.file) {
    const fileName = node.file.split('/').pop() ?? node.file;
    const detailFontSize = Math.max(8 / globalScale, 4);
    ctx.font = `400 ${detailFontSize}px ui-monospace, SFMono-Regular, monospace`;
    ctx.fillStyle = '#94a3b8';
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
    const baseRadius = Math.sqrt(node.val) * 2.5 + 2;
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

    const showLabel = globalScale > 1.2 || baseRadius > 6;
    if (showLabel && highlighted) {
      drawNodeLabel(ctx, node, x, y, baseRadius, globalScale, opacity);
    }

    ctx.restore();
  };
}

export default function GraphCanvas({ graph }: Props) {
  const filters = useVaultStore((s) => s.graphFilters);
  const selectedSymbolId = useVaultStore((s) => s.selectedSymbolId);
  const setSelectedSymbol = useVaultStore((s) => s.setSelectedSymbol);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<ForceGraphMethods<any, any> | undefined>(undefined);

  const { nodes, links } = useMemo(
    () => buildGraphData(graph, filters),
    [graph, filters],
  );

  const interactions = useGraphInteractions({ links });

  const nodeCanvasObject = useMemo(
    () => nodeCanvasObjectFn(interactions, selectedSymbolId),
    [interactions, selectedSymbolId],
  );

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      setSelectedSymbol(node.id);
      // Center view on selected node with animation
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
      return highlighted ? 'rgba(148, 163, 184, 0.45)' : 'rgba(148, 163, 184, 0.08)';
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

  const detailTarget: GraphDetailTarget | null = useMemo(() => {
    if (!selectedSymbolId) return null;
    const n = nodes.find((nn) => nn.id === selectedSymbolId);
    if (!n) return null;
    return {
      id: n.id,
      label: n.label,
      kind: n.kind,
    };
  }, [nodes, selectedSymbolId]);

  const fileCount = useMemo(() => {
    const files = new Set<string>();
    for (const n of nodes) {
      if (n.file) files.add(n.file);
    }
    return files.size;
  }, [nodes]);

  return (
    <ResizablePanelGroup direction="horizontal" className="h-full w-full">
      <ResizablePanel defaultSize={18} minSize={12} maxSize={30}>
        <GraphFilterPanel visibleCount={nodes.length} totalCount={graph.nodes.length} />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={56} minSize={30}>
        <div
          className="h-full w-full relative"
          style={{ background: 'var(--graph-bg)' }}
          data-testid="graph-canvas"
        >
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
            linkDirectionalArrowColor={() => 'rgba(148,163,184,0.3)'}
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
          <GraphStatsOverlay
            nodeCount={nodes.length}
            edgeCount={links.length}
            fileCount={fileCount}
            connectionCounts={interactions.connectionCounts}
          />
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={26} minSize={16} maxSize={40}>
        <GraphDetailPanel target={detailTarget} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
