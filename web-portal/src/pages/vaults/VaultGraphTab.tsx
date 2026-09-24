import { useEffect, useState, Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useVaultStore,
  type CanvasJson,
  type CanvasNode,
  type CanvasEdge,
} from '../../stores/vault-store';
import { apiFetch } from '../../utils/api'

// GraphCanvas pulls in react-force-graph-2d; defer to keep initial bundle lean.
const GraphCanvas = lazy(() => import('./graph/GraphCanvas'));

function sanitizeCanvas(raw: unknown): CanvasJson {
  const src = (raw ?? {}) as Partial<CanvasJson>;
  const nodes: CanvasNode[] = [];
  for (const n of (src.nodes ?? []) as Partial<CanvasNode>[]) {
    if (!n?.id) continue;
    nodes.push({
      id: n.id,
      type: n.type === 'file' ? 'file' : 'text',
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
  const SIDES = new Set(['top', 'right', 'bottom', 'left']);
  for (const e of (src.edges ?? []) as Partial<CanvasEdge>[]) {
    if (!e?.id || !ids.has(e.fromNode!) || !ids.has(e.toNode!)) continue;
    edges.push({
      id: e.id,
      fromNode: e.fromNode!,
      toNode: e.toNode!,
      fromSide: SIDES.has(e.fromSide as string) ? e.fromSide : undefined,
      toSide: SIDES.has(e.toSide as string) ? e.toSide : undefined,
      color: typeof e.color === 'string' ? e.color : undefined,
      label: e.label,
    });
  }
  return { nodes, edges };
}

export default function VaultGraphTab() {
  const { t } = useTranslation('vault');
  const selected = useVaultStore((s) => s.selected);
  const graph = useVaultStore((s) => (selected ? s.graphCache[selected] : undefined));
  const setGraph = useVaultStore((s) => s.setGraph);
  // The vault whose graph failed to load this visit. A failure is not cached
  // as an empty graph, which stuck until the cache was cleared (WEB-22).
  const [failedFor, setFailedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!selected || graph !== undefined || failedFor === selected) return;
    setGraph(selected, null);
    apiFetch(`/api/vaults/${encodeURIComponent(selected)}/canvas`)
      .then((r) => {
        if (!r.ok) throw new Error(`vault graph failed: ${r.status}`);
        return r.json();
      })
      .then((j) => setGraph(selected, sanitizeCanvas(j)))
      .catch(() => {
        useVaultStore.setState((s) => {
          const graphCache = { ...s.graphCache };
          delete graphCache[selected];
          return { graphCache };
        });
        setFailedFor(selected);
      });
  }, [selected, graph, setGraph, failedFor]);

  if (!selected) {
    return <div className="p-4 text-sm text-muted-foreground">{t('empty.selectVault')}</div>;
  }

  if (failedFor === selected) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t('empty.graphFailed')}{' '}
        <button type="button" className="underline" onClick={() => setFailedFor(null)}>
          {t('empty.retry')}
        </button>
      </div>
    );
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
