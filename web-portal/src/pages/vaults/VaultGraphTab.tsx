import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useVaultStore,
  type CanvasJson,
  type CanvasNode,
  type CanvasEdge,
} from '../../stores/vault-store';
import { GraphCanvas } from './graph/GraphCanvas';

/**
 * Coerce unknown backend payload to a safe CanvasJson. Guards against malformed
 * responses (missing fields, NaN positions, non-array edges) that would otherwise
 * crash d3-force or ReactFlow layout.
 */
function sanitizeCanvas(raw: unknown): CanvasJson {
  const src = (raw ?? {}) as Partial<CanvasJson>;
  const rawNodes = Array.isArray(src.nodes) ? src.nodes : [];
  const rawEdges = Array.isArray(src.edges) ? src.edges : [];
  const nodes: CanvasNode[] = [];
  for (const n of rawNodes as Partial<CanvasNode>[]) {
    if (!n || typeof n.id !== 'string') continue;
    const x = Number.isFinite(n.x) ? (n.x as number) : 0;
    const y = Number.isFinite(n.y) ? (n.y as number) : 0;
    const width = Number.isFinite(n.width) ? (n.width as number) : 220;
    const height = Number.isFinite(n.height) ? (n.height as number) : 60;
    nodes.push({
      id: n.id,
      type: 'text',
      text: typeof n.text === 'string' ? n.text : '',
      x, y, width, height,
      color: typeof n.color === 'string' ? n.color : undefined,
      file: typeof n.file === 'string' ? n.file : undefined,
      kind: typeof n.kind === 'string' ? n.kind : undefined,
    });
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges: CanvasEdge[] = [];
  for (const e of rawEdges as Partial<CanvasEdge>[]) {
    if (!e || typeof e.id !== 'string') continue;
    if (typeof e.fromNode !== 'string' || typeof e.toNode !== 'string') continue;
    if (!ids.has(e.fromNode) || !ids.has(e.toNode)) continue;
    edges.push({
      id: e.id,
      fromNode: e.fromNode,
      toNode: e.toNode,
      label: typeof e.label === 'string' ? e.label : undefined,
    });
  }
  return { nodes, edges };
}

export default function VaultGraphTab() {
  const { t } = useTranslation('vault');
  const selected = useVaultStore((s) => s.selected);
  // Granular selector keyed on `selected` — avoids re-subscribing the whole
  // graphCache map on every render.
  const graph = useVaultStore((s) => (selected ? s.graphCache[selected] : undefined));
  const setGraph = useVaultStore((s) => s.setGraph);
  const clearGraph = useVaultStore((s) => s.clearGraph);

  useEffect(() => {
    if (!selected) return;
    // Cache states:
    //   undefined → not fetched yet (this effect triggers a fetch)
    //   null      → in-flight sentinel (this effect was already triggered)
    //   CanvasJson→ loaded
    if (graph !== undefined) return;

    // Write the in-flight sentinel BEFORE fetch so a quick re-render (e.g. vault
    // re-selection under fast clicks) sees null and skips re-fetching.
    setGraph(selected, null);
    const ctrl = new AbortController();

    fetch(`/api/vaults/${encodeURIComponent(selected)}/canvas`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: unknown) => setGraph(selected, sanitizeCanvas(j)))
      .catch((err: unknown) => {
        if ((err as Error).name === 'AbortError') {
          // Restore undefined so a subsequent selection of the same vault can retry.
          clearGraph(selected);
          return;
        }
        setGraph(selected, { nodes: [], edges: [] });
      });

    return () => ctrl.abort();
  }, [selected, graph, setGraph, clearGraph]);

  if (!selected) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t('empty.selectVault')}
      </div>
    );
  }
  // undefined or null both mean "not ready yet" (not in cache / in-flight).
  if (!graph) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t('empty.loading')}
      </div>
    );
  }
  if (graph.nodes.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t('empty.noSymbols')}
      </div>
    );
  }

  return <GraphCanvas graph={graph} />;
}
