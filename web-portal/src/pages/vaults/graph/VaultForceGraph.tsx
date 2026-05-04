import { useMemo, useRef, useCallback, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { CanvasJson, CanvasNode as StoreCanvasNode, CanvasEdge as StoreCanvasEdge } from '../../../stores/vault-store';

interface Props {
  canvas: CanvasJson;
}

interface GraphNode {
  id: string;
  label: string;
  color: string;
  val: number;
  group: string;
}

interface GraphLink {
  source: string;
  target: string;
  label?: string;
}

/**
 * Obsidian-quality vault graph using react-force-graph-2d.
 *
 * Features:
 * - Circular nodes sized by connection weight
 * - Full node coloring (not just border)
 * - Hover highlighting: connected nodes bright, others dim
 * - Zoom-driven label visibility
 * - Continuous physics simulation
 * - Thin, subtle edges
 */
export function VaultForceGraph({ canvas }: Props) {
  const fgRef = useRef<any>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);

  // Pre-compute adjacency for hover highlighting
  const { graphData, adjacency } = useMemo(() => {
    const nodes: GraphNode[] = canvas.nodes.map((n: StoreCanvasNode) => ({
      id: n.id,
      label: n.text,
      color: n.color ?? '#6B7280',
      val: Math.max(n.weight ?? 0.3, 0.1) * 5 + 1,
      group: n.group ?? 'unknown',
    }));

    const links: GraphLink[] = canvas.edges.map((e: StoreCanvasEdge) => ({
      source: e.fromNode,
      target: e.toNode,
      label: e.label,
    }));

    // Build adjacency map
    const adj = new Map<string, Set<string>>();
    for (const link of links) {
      const sourceId = link.source;
      const targetId = link.target;
      if (!adj.has(sourceId)) adj.set(sourceId, new Set());
      if (!adj.has(targetId)) adj.set(targetId, new Set());
      adj.get(sourceId)!.add(targetId);
      adj.get(targetId)!.add(sourceId);
    }

    return { graphData: { nodes, links }, adjacency: adj };
  }, [canvas]);

  const handleNodeHover = useCallback(
    (node: any) => {
      setHoverNode(node ? node.id : null);
    },
    []
  );

  // Determine if a node should be highlighted
  const isNodeHighlighted = useCallback(
    (nodeId: string) => {
      if (!hoverNode) return true;
      if (nodeId === hoverNode) return true;
      return adjacency.get(hoverNode)?.has(nodeId) ?? false;
    },
    [hoverNode, adjacency]
  );

  // Determine if a link should be highlighted
  const isLinkHighlighted = useCallback(
    (link: GraphLink) => {
      if (!hoverNode) return true;
      return link.source === hoverNode || link.target === hoverNode;
    },
    [hoverNode]
  );

  // Custom node canvas object for circular nodes with labels
  const nodeCanvasObject = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const isHighlighted = isNodeHighlighted(node.id);
      const opacity = !hoverNode || isHighlighted ? 0.9 : 0.15;
      const radius = Math.sqrt(node.val) * 3;

      // Draw circle
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);
      ctx.fillStyle = node.color;
      ctx.globalAlpha = opacity;
      ctx.fill();

      // Draw border for highlighted nodes
      if (isHighlighted && hoverNode) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5 / globalScale;
        ctx.stroke();
      }

      ctx.globalAlpha = 1;

      // Draw label when zoomed in or node is large
      const showLabel = globalScale > 1.2 || node.val > 2;
      if (showLabel && isHighlighted) {
        const label = node.label || node.id;
        const fontSize = Math.max(10 / globalScale, 4);
        ctx.font = `${fontSize}px system-ui, -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#e2e8f0';
        ctx.globalAlpha = opacity;
        ctx.fillText(label, node.x, node.y + radius + 2);
        ctx.globalAlpha = 1;
      }
    },
    [hoverNode, isNodeHighlighted]
  );

  return (
    <div className="w-full h-full relative" style={{ background: 'var(--graph-bg)' }}>
      <ForceGraph2D
        ref={fgRef}
        graphData={graphData}
        width={undefined}
        height={undefined}
        backgroundColor="transparent"
        nodeRelSize={1}
        nodeVal="val"
        nodeCanvasObject={nodeCanvasObject}
        nodeCanvasObjectMode={() => 'replace'}
        linkColor={(link: GraphLink) => {
          const highlighted = isLinkHighlighted(link);
          return highlighted ? 'rgba(75, 85, 99, 0.4)' : 'rgba(75, 85, 99, 0.05)';
        }}
        linkWidth={(link: GraphLink) => (isLinkHighlighted(link) ? 1.5 : 0.5)}
        enableNodeDrag={true}
        enableZoomInteraction={true}
        enablePanInteraction={true}
        warmupTicks={200}
        cooldownTime={10000}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
        onNodeHover={handleNodeHover}
        onNodeClick={(node: any) => console.log('Clicked:', node.id)}
        autoPauseRedraw={false}
      />
    </div>
  );
}
