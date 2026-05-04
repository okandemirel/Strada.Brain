import { useEffect } from 'react';
import {
  useVaultStore,
  type CanvasJson,
  type CanvasNode,
  type CanvasEdge,
} from '../../stores/vault-store';
import { VaultForceGraph } from './graph/VaultForceGraph';

function sanitizeCanvas(raw: unknown): CanvasJson {
  const src = (raw ?? {}) as Partial<CanvasJson>;
  const nodes: CanvasNode[] = [];
  for (const n of (src.nodes ?? []) as Partial<CanvasNode>[]) {
    if (!n?.id) continue;
    nodes.push({
      id: n.id,
      type: 'text',
      text: n.text ?? '',
      x: n.x ?? 0,
      y: n.y ?? 0,
      width: n.width ?? 220,
      height: n.height ?? 60,
      color: n.color,
      weight: n.weight,
    });
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges: CanvasEdge[] = [];
  for (const e of (src.edges ?? []) as Partial<CanvasEdge>[]) {
    if (!e?.id || !ids.has(e.fromNode!) || !ids.has(e.toNode!)) continue;
    edges.push({ id: e.id, fromNode: e.fromNode!, toNode: e.toNode! });
  }
  return { nodes, edges };
}

export default function VaultGraphTab() {
  const selected = useVaultStore((s) => s.selected);
  const graph = useVaultStore((s) => (selected ? s.graphCache[selected] : undefined));
  const setGraph = useVaultStore((s) => s.setGraph);

  useEffect(() => {
    if (!selected || graph !== undefined) return;
    setGraph(selected, null);
    fetch(`/api/vaults/${encodeURIComponent(selected)}/canvas`)
      .then((r) => r.json())
      .then((j) => setGraph(selected, sanitizeCanvas(j)))
      .catch(() => setGraph(selected, { nodes: [], edges: [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  if (!graph?.nodes.length) {
    return <div className="p-4 text-sm text-muted-foreground">Vault seçiniz</div>;
  }

  return <VaultForceGraph canvas={graph} />;
}
