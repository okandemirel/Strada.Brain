import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Check, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useVaultStore } from '../../stores/vault-store';
import { formatRelativeI18n } from '../../utils/format';

/**
 * Obsidian-style bottom status bar: symbol/file counts + last sync time +
 * reindex trigger. Derives live counts from vault-store; no backend polling.
 */
export function VaultStatusBar() {
  const { t } = useTranslation('vault');
  const vaultId = useVaultStore((s) => s.selected);
  const graph = useVaultStore((s) => (s.selected ? s.graphCache[s.selected] : null));
  const clearGraph = useVaultStore((s) => s.clearGraph);

  const [lastSync, setLastSync] = useState<number | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [reindexError, setReindexError] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());
  const prevGraphRef = useRef<typeof graph | undefined>(undefined);

  // Record a timestamp the first time we see a non-empty graph for each
  // distinct graph object. Writing via useEffect here is intentional — this
  // is exactly the "sync to an external clock" use case the rule allows.
  useEffect(() => {
    if (graph && graph.nodes.length > 0 && prevGraphRef.current !== graph) {
      prevGraphRef.current = graph;
      setLastSync(Date.now());
    }
  }, [graph]);

  // Re-render every 10s so the relative timestamp stays current. This is a
  // legitimate external-sync effect (setInterval), which is the pattern the
  // React 19 purity rules allow.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  const symbolCount = graph?.nodes.length ?? 0;
  // Memoize per-graph file count so re-renders (e.g. the 10s tick for the
  // relative timestamp) don't rebuild the Set each time.
  const fileCount = useMemo(() => {
    if (!graph) return 0;
    const set = new Set<string>();
    for (const n of graph.nodes) if (n.file) set.add(n.file);
    return set.size;
  }, [graph]);

  // `now` is a synced-from-external state; subtraction is pure. The i18n
  // helper reads from the shared `common:time.*` namespace so any component
  // that needs "X units ago" formatting shares one set of keys.
  const relative = lastSync ? formatRelativeI18n(now - lastSync, t) : null;

  const triggerReindex = async () => {
    if (!vaultId || reindexing) return;
    setReindexing(true);
    setReindexError(false);
    // Optimistically clear cache so Graph tab refetches.
    clearGraph(vaultId);
    // Surface HTTP failures AND network errors to the user via the status
    // indicator — silent failures previously hid 404/500 responses entirely.
    try {
      const res = await fetch(
        `/api/vaults/${encodeURIComponent(vaultId)}/reindex`,
        { method: 'POST' },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch {
      // Endpoint may not exist; mark error so the AlertCircle indicator shows.
      // Cache clear still causes graph to refetch on next open.
      setReindexError(true);
    } finally {
      setReindexing(false);
    }
  };

  return (
    <div
      className="h-6 flex items-center justify-between px-3 gap-3 border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] text-[11px] text-[var(--color-text-tertiary)] select-none"
      role="contentinfo"
    >
      <div className="flex items-center gap-3">
        {vaultId ? (
          <>
            <span>{t('status.symbols', { count: symbolCount })}</span>
            <span className="opacity-50">•</span>
            <span>{t('status.files', { count: fileCount })}</span>
          </>
        ) : (
          <span className="opacity-60">{t('files.selectVault')}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {vaultId && (
          <>
            <span className="flex items-center gap-1">
              {reindexError ? (
                <AlertCircle
                  className="w-3 h-3 text-[var(--color-error)]"
                  aria-label={t('status.reindexError')}
                />
              ) : lastSync ? (
                <Check className="w-3 h-3 text-[var(--color-success)]" />
              ) : null}
              {relative
                ? t('status.lastSync', { time: relative })
                : t('status.neverSynced')}
            </span>
            <button
              type="button"
              onClick={triggerReindex}
              disabled={reindexing}
              className={cn(
                'flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] transition-colors',
                'hover:bg-[var(--color-surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]/60',
                reindexing && 'opacity-60 cursor-wait',
              )}
              title={t('status.reindex')}
              aria-label={t('status.reindex')}
            >
              <RefreshCw className={cn('w-3 h-3', reindexing && 'animate-spin')} />
              <span>{reindexing ? t('status.reindexing') : t('status.reindex')}</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default VaultStatusBar;
