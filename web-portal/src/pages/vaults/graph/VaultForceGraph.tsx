import { useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { CanvasJson } from '../../../stores/vault-store';

interface Props {
  canvas: CanvasJson;
}

export function VaultForceGraph({ canvas }: Props) {
  const fgRef = useRef<any>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);

  const { nodes, links, adjacency } = useMemo(() => {
    const nodes = canvas.nodes.map((n) => ({
      id: n.id,
      label: n.text,
      color: n.color ?? '#6B7280',
      val: Math.max(n.weight ?? 0.3, 0.1) * 5 + 1,
      group: n.group ?? 'unknown',
    }));

    const links = canvas.edges.map((e) => ({
      source: e.fromNode,
      target: e.toNode,
      label: e.label,
    }));

    const adj = new Map<string, Set<string>>();
    for (const { source, target } of links) {
      if (!adj.has(source)) adj.set(source, new Set());
      if (!adj.has(target)) adj.set(target, new Set());
      adj.get(source)!.add(target);
      adj.get(target)!.add(source);
    }

    return { nodes, links, adjacency: adj };
  }, [canvas]);

  const graphData = useMemo(() => ({ nodes, links }), [nodes, links]);

  const isHighlighted = (nodeId: string) => {
    if (!hoverNode) return true;
    if (nodeId === hoverNode) return true;
    return adjacency.get(hoverNode)?.has(nodeId) ?? false;
  };

  const isLinkHighlighted = (source: string, target: string) => {
    if (!hoverNode) return true;
    return source === hoverNode || target === hoverNode;
  };

  const nodeCanvasObject = (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const highlighted = isHighlighted(node.id);
    const opacity = !hoverNode || highlighted ? 0.9 : 0.15;
    const radius = Math.sqrt(node.val) * 3;

    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = node.color;
    ctx.globalAlpha = opacity;
    ctx.fill();

    if (highlighted && hoverNode) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5 / globalScale;
      ctx.stroke();
    }

    ctx.globalAlpha = 1;

    const showLabel = globalScale > 1.2 || node.val > 2;
    if (showLabel && highlighted) {
      const fontSize = Math.max(10 / globalScale, 4);
      ctx.font = `${fontSize}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#e2e8f0';
      ctx.globalAlpha = opacity;
      ctx.fillText(node.label || node.id, node.x, node.y + radius + 2);
      ctx.globalAlpha = 1;
    }
  };

  return (
    <div className="w-full h-full relative" style={{ background: 'var(--graph-bg)' }}>
      <ForceGraph2D
        ref={fgRef}
        graphData={graphData}
        backgroundColor="transparent"
        nodeRelSize={1}
        nodeVal="val"
        nodeCanvasObject={nodeCanvasObject}
        nodeCanvasObjectMode={() => 'replace'}
        linkColor={(link: any) => {
          const highlighted = isLinkHighlighted(link.source.id || link.source, link.target.id || link.target);
          return highlighted ? 'rgba(75, 85, 99, 0.4)' : 'rgba(75, 85, 99, 0.05)';
        }}
        linkWidth={(link: any) => {
          const highlighted = isLinkHighlighted(link.source.id || link.source, link.target.id || link.target);
          return highlighted ? 1.5 : 0.5;
        }}
        onNodeHover={(node: any) => setHoverNode(node ? node.id : null)}
        onNodeClick={(node: any) => { /* node click handler */ }}
        autoPauseRedraw={false}
      />
    </div>
  );
}
