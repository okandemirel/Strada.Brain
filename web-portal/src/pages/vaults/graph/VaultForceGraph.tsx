import { useMemo, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { CanvasJson } from '../../../stores/vault-store';

interface Props {
  canvas: CanvasJson;
}

interface GraphNode {
  id: string;
  label: string;
  color: string;
  val: number;
  x: number;
  y: number;
}

interface GraphLink {
  source: string;
  target: string;
  label?: string;
}

export function VaultForceGraph({ canvas }: Props) {
  const [hoverNode, setHoverNode] = useState<string | null>(null);

  const { graphData, adjacency } = useMemo(() => {
    const nodes = canvas.nodes.map((n) => ({
      id: n.id,
      label: n.text,
      color: n.color ?? '#6B7280',
      val: Math.max(n.weight ?? 0.3, 0.1) * 5 + 1,
      x: 0,
      y: 0,
    }));

    const links: GraphLink[] = canvas.edges.map((e) => ({
      source: e.fromNode,
      target: e.toNode,
      label: e.label,
    }));

    const adj = new Map<string, Set<string>>();
    for (const link of links) {
      if (!adj.has(link.source)) adj.set(link.source, new Set());
      if (!adj.has(link.target)) adj.set(link.target, new Set());
      adj.get(link.source)!.add(link.target);
      adj.get(link.target)!.add(link.source);
    }

      return { graphData: { nodes, links }, adjacency: adj };
  }, [canvas]);

  const isHighlighted = (nodeId: string) => {
    if (!hoverNode) return true;
    if (nodeId === hoverNode) return true;
    return adjacency.get(hoverNode)?.has(nodeId) ?? false;
  };

  const isLinkHighlighted = (source: string, target: string) => {
    if (!hoverNode) return true;
    return source === hoverNode || target === hoverNode;
  };

  const nodeCanvasObject = (node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const highlighted = isHighlighted(node.id);
    const opacity = !hoverNode || highlighted ? 0.9 : 0.15;
    const radius = Math.sqrt(node.val) * 3;
    const x = node.x ?? 0;
    const y = node.y ?? 0;

    // Draw circle
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = node.color;
    ctx.globalAlpha = opacity;
    ctx.fill();

    // Draw border for highlighted nodes
    if (highlighted && hoverNode) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5 / globalScale;
      ctx.stroke();
    }

    ctx.globalAlpha = 1;

    // Draw label when zoomed in or node is large
    const showLabel = globalScale > 1.2 || node.val > 2;
    if (showLabel && highlighted) {
      const fontSize = Math.max(10 / globalScale, 4);
      ctx.font = `${fontSize}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#e2e8f0';
      ctx.globalAlpha = opacity;
      ctx.fillText(node.label || node.id, x, y + radius + 2);
      ctx.globalAlpha = 1;
    }
  };

  return (
    <div className="w-full h-full relative">
      <ForceGraph2D
        graphData={graphData}
        backgroundColor="transparent"
        nodeRelSize={1}
        nodeVal="val"
        nodeCanvasObject={nodeCanvasObject}
        nodeCanvasObjectMode={() => 'replace'}
        linkColor={(link: GraphLink) => {
          const highlighted = isLinkHighlighted(link.source, link.target);
          return highlighted ? 'rgba(75, 85, 99, 0.4)' : 'rgba(75, 85, 99, 0.05)';
        }}
        linkWidth={(link: GraphLink) => {
          const highlighted = isLinkHighlighted(link.source, link.target);
          return highlighted ? 1.5 : 0.5;
        }}
        onNodeHover={(node: GraphNode | null) => setHoverNode(node ? node.id : null)}
        autoPauseRedraw={false}
      />
    </div>
  );
}
