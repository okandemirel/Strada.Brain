import { useEffect, Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useVaultStore,
  type CanvasJson,
  type CanvasNode,
  type CanvasEdge,
} from '../../stores/vault-store';

// GraphCanvas pulls in react-force-graph-2d; defer to keep initial bundle lean.
const GraphCanvas = lazy(() => import('./graph/GraphCanvas'));

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
      file: n.file,
      kind: n.kind,
      weight: n.weight,
      group: n.group,
    });
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges: CanvasEdge[] = [];
  for (const e of (src.edges ?? []) as Partial<CanvasEdge>[]) {
    if (!e?.id || !ids.has(e.fromNode!) || !ids.has(e.toNode!)) continue;
    edges.push({ id: e.id, fromNode: e.fromNode!, toNode: e.toNode!, label: e.label });
  }
  return { nodes, edges };
}

export default function VaultGraphTab() {
  const { t } = useTranslation('vault');
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
  }, [selected, graph, setGraph]);

  if (!selected) {
    return <div className="p-4 text-sm text-muted-foreground">{t('empty.selectVault')}</div>;
  }

  if (!graph) {
    return <div className="p-4 text-sm text-muted-foreground">{t('empty.fetching')}</div>;
  }

  if (graph.nodes.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">{t('empty.noGraphData')}</div>;
  }

  return (
    <Suspense
      fallback={
        <div className="p-4 text-sm text-muted-foreground">{t('empty.loading')}</div>
      }
    >
      <GraphCanvas graph={graph} />
    </Suspense>
  );
}
