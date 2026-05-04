import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, FileCode, ArrowLeft } from 'lucide-react';
import { useVaultStore } from '../../../stores/vault-store';
import { getKindStyle, parseNodeText } from './node-style';

interface VaultEdgeResponseItem {
  fromSymbol: string;
  toSymbol: string;
  kind: string;
  atLine: number;
}

export interface GraphDetailTarget {
  /** CanvasNode.id (= VaultSymbol.symbolId). */
  id: string;
  /** Raw node.text from backend canvas (markdown). */
  label: string;
  /** CanvasNode.kind passthrough. */
  kind: string | null;
}

interface Props {
  target: GraphDetailTarget | null;
}

export function GraphDetailPanel({ target }: Props) {
  const { t } = useTranslation('vault');
  const vaultId = useVaultStore((s) => s.selected);
  const setSelectedSymbol = useVaultStore((s) => s.setSelectedSymbol);
  const setActiveFilePath = useVaultStore((s) => s.setActiveFilePath);
  const setActiveTab = useVaultStore((s) => s.setActiveTab);
  const [callers, setCallers] = useState<VaultEdgeResponseItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  // Reset transient state during render when the target/vault key changes so
  // the UI shows a fresh "loading" on the first render after the swap.
  const key = `${vaultId ?? ''}::${target?.id ?? ''}`;
  const [prevKey, setPrevKey] = useState<string>(key);
  if (key !== prevKey) {
    setPrevKey(key);
    setCallers(null);
    setError(false);
    setLoading(Boolean(target && vaultId));
  }

  useEffect(() => {
    if (!target || !vaultId) return;
    const ctrl = new AbortController();
    fetch(
      `/api/vaults/${encodeURIComponent(vaultId)}/symbols/${encodeURIComponent(target.id)}/callers`,
      { signal: ctrl.signal },
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { items?: VaultEdgeResponseItem[] }) => {
        setCallers(j.items ?? []);
        setLoading(false);
      })
      .catch((err) => {
        if ((err as Error).name === 'AbortError') return;
        setCallers([]);
        setError(true);
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [target, vaultId]);

  if (!target) {
    return (
      <aside className="h-full flex items-center justify-center p-4 text-xs text-muted-foreground bg-[var(--graph-panel-bg)] border-l border-[var(--graph-panel-border)]">
        {t('detail.empty')}
      </aside>
    );
  }

  const parsed = parseNodeText(target.label);
  const kind = target.kind ?? parsed.kind;
  const style = getKindStyle(kind);
  const Icon = style.icon;

  const handleGoToFile = () => {
    if (parsed.file) {
      setActiveFilePath(parsed.file);
      setActiveTab('files');
    }
  };

  return (
    <aside
      className="h-full flex flex-col overflow-y-auto bg-[var(--graph-panel-bg)] border-l border-[var(--graph-panel-border)]"
      aria-label={t('detail.title')}
    >
      <header className="flex items-start justify-between p-3 border-b border-[var(--graph-panel-border)] gap-2">
        <div className="flex items-start gap-2 min-w-0 flex-1">
          <div
            className="mt-0.5 w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
            style={{ background: style.color }}
          >
            <Icon className="w-3 h-3" style={{ color: '#000' }} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {t(`filter.kind.${kind ?? 'unknown'}`, { defaultValue: kind ?? 'symbol' })}
            </div>
            <div className="text-sm font-semibold break-words">{parsed.name}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setSelectedSymbol(null)}
          className="p-1 rounded hover:bg-[var(--graph-node-surface-hover)] text-muted-foreground hover:text-foreground"
          aria-label={t('detail.closeLabel')}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </header>

      {parsed.file && (
        <section className="px-3 py-2 border-b border-[var(--graph-panel-border)]">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            {t('detail.location')}
          </div>
          <code className="block text-xs font-mono text-foreground break-all mb-2">
            {parsed.file}
            {parsed.line != null && <span className="text-muted-foreground">:{parsed.line}</span>}
          </code>
          <button
            type="button"
            onClick={handleGoToFile}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium
                       bg-[var(--graph-node-surface)] hover:bg-[var(--graph-node-surface-hover)]
                       text-foreground border border-[var(--graph-panel-border)] transition-colors"
          >
            <FileCode className="w-3 h-3" />
            {t('detail.goToFile', { defaultValue: 'Go to file' })}
          </button>
        </section>
      )}

      <section className="px-3 py-2 border-b border-[var(--graph-panel-border)]">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
          {t('detail.incoming')}
        </div>
        {loading ? (
          <div className="text-xs text-muted-foreground animate-pulse">…</div>
        ) : error ? (
          <div className="text-xs text-[var(--color-error,#f87171)]">{t('detail.loadError')}</div>
        ) : !callers || callers.length === 0 ? (
          <div className="text-xs text-muted-foreground">{t('detail.noIncoming')}</div>
        ) : (
          <ul className="space-y-1">
            {callers.map((edge) => (
              <li
                key={`${edge.fromSymbol}:${edge.kind}:${edge.atLine}`}
                className="flex items-center gap-1.5 text-xs"
              >
                <ArrowLeft className="w-2.5 h-2.5 text-[var(--graph-edge-active)] flex-shrink-0" />
                <span className="text-[var(--graph-edge-active)] font-medium">{edge.kind}</span>
                <span className="font-mono text-foreground truncate">{edge.fromSymbol}</span>
                <span className="text-muted-foreground font-mono">:{edge.atLine}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
