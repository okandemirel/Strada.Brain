import { useEffect, useMemo } from 'react';
import { useVaultStore, type CanvasJson } from '../../stores/vault-store';
import { ReactFlow, Background, Controls, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

function toFlow(canvas: CanvasJson): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: canvas.nodes.map((n) => ({
      id: n.id,
      position: { x: n.x, y: n.y },
      data: { label: n.text.replace(/\*\*/g, '').replace(/\*/g, '') },
      style: {
        width: n.width,
        height: n.height,
        background: n.color ?? '#eee',
        fontSize: 11,
        padding: 4,
      },
    })),
    edges: canvas.edges.map((e) => ({
      id: e.id,
      source: e.fromNode,
      target: e.toNode,
      label: e.label,
    })),
  };
}

export default function VaultGraphTab() {
  const selected = useVaultStore((s) => s.selected);
  const graph = useVaultStore((s) => (selected ? s.graphCache[selected] : null));
  const setGraph = useVaultStore((s) => s.setGraph);

  useEffect(() => {
    if (!selected) return;
    if (graph !== undefined) return;
    let cancelled = false;
    fetch(`/api/vaults/${encodeURIComponent(selected)}/canvas`)
      .then((r) => (r.ok ? r.json() : { nodes: [], edges: [] }))
      .then((j: CanvasJson) => { if (!cancelled) setGraph(selected, j); })
      .catch(() => { if (!cancelled) setGraph(selected, { nodes: [], edges: [] }); });
    return () => { cancelled = true; };
  }, [selected, graph, setGraph]);

  const flow = useMemo(
    () => (graph ? toFlow(graph) : { nodes: [], edges: [] }),
    [graph],
  );

  if (!selected) return <div className="p-4 text-sm text-muted-foreground">Select a vault to view the graph.</div>;
  if (!graph) return <div className="p-4 text-sm text-muted-foreground">Loading graph…</div>;
  if (flow.nodes.length === 0) return <div className="p-4 text-sm text-muted-foreground">No symbols indexed yet.</div>;

  return (
    <div className="h-full w-full">
      <ReactFlow nodes={flow.nodes} edges={flow.edges} fitView proOptions={{ hideAttribution: true }}>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
