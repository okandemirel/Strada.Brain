import { useMemo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { CanvasJson } from '../../../stores/vault-store';

interface Props {
  canvas: CanvasJson;
}

export function VaultForceGraph({ canvas }: Props) {
  const graphData = useMemo(() => ({
    nodes: canvas.nodes.map((n) => ({
      id: n.id,
      label: n.text,
      color: n.color ?? '#6B7280',
      val: Math.max(n.weight ?? 0.3, 0.1) * 5 + 1,
    })),
    links: canvas.edges.map((e) => ({
      source: e.fromNode,
      target: e.toNode,
    })),
  }), [canvas]);

  return (
    <div className="w-full h-full">
      <ForceGraph2D
        graphData={graphData}
        backgroundColor="transparent"
        nodeRelSize={1}
        nodeVal="val"
        nodeLabel="label"
        nodeColor="color"
        linkColor={() => 'rgba(75, 85, 99, 0.2)'}
        linkWidth={0.5}
      />
    </div>
  );
}
