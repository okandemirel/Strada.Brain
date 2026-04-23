import { useCallback, useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeMouseHandler,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';

import {
  useVaultStore,
  type CanvasJson,
  type SymbolKind,
} from '../../../stores/vault-store';
import { GraphEdge } from './GraphEdge';
import { GraphFilterPanel } from './GraphFilterPanel';
import { GraphDetailPanel, type GraphDetailTarget } from './GraphDetailPanel';
import { GraphMiniMap } from './GraphMiniMap';
import { GraphNode, type GraphNodeData } from './GraphNode';
import { useForceLayout } from './useForceLayout';
import { parseNodeText } from './node-style';

const nodeTypes: NodeTypes = { graphNode: GraphNode };
const edgeTypes: EdgeTypes = { graphEdge: GraphEdge };

function kindEnabled(
  kind: string | null,
  enabled: Record<SymbolKind, boolean>,
): boolean {
  if (!kind) return true; // unknown kind always visible
  return (enabled as Record<string, boolean>)[kind] ?? true;
}

interface Props {
  graph: CanvasJson;
}

function GraphCanvasInner({ graph }: Props) {
  const filters = useVaultStore((s) => s.graphFilters);
  const selectedSymbolId = useVaultStore((s) => s.selectedSymbolId);
  const setSelectedSymbol = useVaultStore((s) => s.setSelectedSymbol);

  // Layout over the FULL node set, so toggling filters only shows/hides —
  // it doesn't reshuffle positions.
  const layoutNodes = useMemo(
    () => graph.nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    [graph.nodes],
  );
  const layoutEdges = useMemo(
    () => graph.edges.map((e) => ({ source: e.fromNode, target: e.toNode })),
    [graph.edges],
  );
  const positions = useForceLayout(layoutNodes, layoutEdges);

  const searchLower = filters.search.trim().toLowerCase();
  const fileLower = filters.fileFilter.trim().toLowerCase();

  // Heavy pass: parse text, apply filters, compute positions. Selection is
  // intentionally NOT a dep here so clicking a node doesn't re-run O(N) parsing.
  const { baseNodes, rfEdges, visibleCount } = useMemo(() => {
    let visible = 0;
    const nodes: Node<GraphNodeData>[] = graph.nodes.map((n) => {
      const parsed = parseNodeText(n.text);
      const kind = n.kind ?? parsed.kind;
      const labelLower = parsed.name.toLowerCase();
      const fileStr = (n.file ?? parsed.file ?? '').toLowerCase();

      const passKind = kindEnabled(kind, filters.kinds);
      const passSearch = !searchLower || labelLower.includes(searchLower);
      const passFile = !fileLower || fileStr.includes(fileLower);
      const hidden = !(passKind && passSearch && passFile);
      if (!hidden) visible++;

      const pos = positions.get(n.id);
      const width = n.width ?? 220;
      const height = n.height ?? 60;

      return {
        id: n.id,
        type: 'graphNode',
        position: pos ? { x: pos.x, y: pos.y } : { x: n.x, y: n.y },
        hidden,
        data: {
          label: n.text,
          kind: kind ?? null,
          weight: 0.5,
        },
        style: { width, height },
      };
    });

    const visibleIds = new Set(nodes.filter((n) => !n.hidden).map((n) => n.id));
    const edges: Edge[] = graph.edges.map((e) => ({
      id: e.id,
      source: e.fromNode,
      target: e.toNode,
      type: 'graphEdge',
      label: e.label,
      hidden: !(visibleIds.has(e.fromNode) && visibleIds.has(e.toNode)),
    }));
    return { baseNodes: nodes, rfEdges: edges, visibleCount: visible };
  }, [
    graph.nodes,
    graph.edges,
    positions,
    filters.kinds,
    searchLower,
    fileLower,
  ]);

  // Cheap pass: stamp the `selected` flag. Runs when selectedSymbolId changes,
  // reusing the heavy-computed `baseNodes` array.
  const rfNodes = useMemo(
    () =>
      baseNodes.map((n) =>
        n.id === selectedSymbolId ? { ...n, selected: true } : n,
      ),
    [baseNodes, selectedSymbolId],
  );

  const onNodeClick: NodeMouseHandler = useCallback(
    (_evt, node) => setSelectedSymbol(node.id),
    [setSelectedSymbol],
  );
  const onPaneClick = useCallback(
    () => setSelectedSymbol(null),
    [setSelectedSymbol],
  );

  const detailTarget: GraphDetailTarget | null = useMemo(() => {
    if (!selectedSymbolId) return null;
    const n = rfNodes.find((nn) => nn.id === selectedSymbolId);
    if (!n) return null;
    return {
      id: n.id,
      label: (n.data as GraphNodeData).label,
      kind: (n.data as GraphNodeData).kind,
    };
  }, [rfNodes, selectedSymbolId]);

  return (
    <ResizablePanelGroup direction="horizontal" className="h-full w-full">
      <ResizablePanel defaultSize={18} minSize={12} maxSize={30}>
        <GraphFilterPanel visibleCount={visibleCount} totalCount={graph.nodes.length} />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={56} minSize={30}>
        <div
          className="h-full w-full relative"
          style={{ background: 'var(--graph-bg)' }}
          data-testid="graph-canvas"
        >
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            onlyRenderVisibleElements
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={18}
              size={1}
              color="var(--graph-grid)"
            />
            <Controls
              showInteractive={false}
              className="!bg-[var(--graph-panel-bg)] !border !border-[var(--graph-panel-border)]"
            />
            <GraphMiniMap />
          </ReactFlow>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={26} minSize={16} maxSize={40}>
        <GraphDetailPanel target={detailTarget} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

export function GraphCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
