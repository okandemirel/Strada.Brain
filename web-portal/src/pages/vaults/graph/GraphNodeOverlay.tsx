import { useEffect, useReducer, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, FileCode, ExternalLink, ArrowLeft, Link2 } from 'lucide-react';
import { useVaultStore } from '../../../stores/vault-store';

interface VaultEdgeResponseItem {
  fromSymbol: string;
  toSymbol: string;
  kind: string;
  atLine: number;
}

interface BacklinkItem {
  fromNote: string;
}

interface Props {
  nodeId: string | null;
  onClose: () => void;
}

type State = {
  callers: VaultEdgeResponseItem[] | null;
  backlinks: BacklinkItem[] | null;
  loadingCallers: boolean;
  loadingBacklinks: boolean;
  errorCallers: boolean;
  errorBacklinks: boolean;
};

type Action =
  | { type: 'reset'; loading: boolean }
  | { type: 'callersSuccess'; callers: VaultEdgeResponseItem[] }
  | { type: 'callersError' }
  | { type: 'backlinksSuccess'; backlinks: BacklinkItem[] }
  | { type: 'backlinksError' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'reset':
      return {
        callers: null,
        backlinks: null,
        loadingCallers: action.loading,
        loadingBacklinks: action.loading,
        errorCallers: false,
        errorBacklinks: false,
      };
    case 'callersSuccess':
      return { ...state, callers: action.callers, loadingCallers: false, errorCallers: false };
    case 'callersError':
      return { ...state, callers: [], loadingCallers: false, errorCallers: true };
    case 'backlinksSuccess':
      return { ...state, backlinks: action.backlinks, loadingBacklinks: false, errorBacklinks: false };
    case 'backlinksError':
      return { ...state, backlinks: [], loadingBacklinks: false, errorBacklinks: true };
    default:
      return state;
  }
}

export function GraphNodeOverlay({ nodeId, onClose }: Props) {
  const { t } = useTranslation('vault');
  const vaultId = useVaultStore((s) => s.selected);
  const setActiveFilePath = useVaultStore((s) => s.setActiveFilePath);
  const setActiveTab = useVaultStore((s) => s.setActiveTab);
  const setSelectedSymbol = useVaultStore((s) => s.setSelectedSymbol);
  const [state, dispatch] = useReducer(reducer, {
    callers: null,
    backlinks: null,
    loadingCallers: false,
    loadingBacklinks: false,
    errorCallers: false,
    errorBacklinks: false,
  });
  const [summary, setSummary] = useState<string | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [summaryError, setSummaryError] = useState(false);

  useEffect(() => {
    setSummary(null);
    setSummaryError(false);
  }, [nodeId]);

  const handleSummarize = async () => {
    if (!nodeId || !vaultId) return;
    setLoadingSummary(true);
    setSummaryError(false);
    try {
      const res = await fetch(
        `/api/vaults/${encodeURIComponent(vaultId)}/symbols/${encodeURIComponent(nodeId)}/summarize`,
        { method: 'POST' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSummary(data.summary ?? null);
    } catch {
      setSummaryError(true);
    } finally {
      setLoadingSummary(false);
    }
  };

  useEffect(() => {
    dispatch({ type: 'reset', loading: Boolean(nodeId && vaultId) });
    if (!nodeId || !vaultId) return;

    const ctrl = new AbortController();

    // Fetch callers
    fetch(
      `/api/vaults/${encodeURIComponent(vaultId)}/symbols/${encodeURIComponent(nodeId)}/callers`,
      { signal: ctrl.signal },
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { items?: VaultEdgeResponseItem[] }) => {
        dispatch({ type: 'callersSuccess', callers: j.items ?? [] });
      })
      .catch((err) => {
        if ((err as Error).name === 'AbortError') return;
        dispatch({ type: 'callersError' });
      });

    // Fetch backlinks (wikilinks)
    fetch(
      `/api/vaults/${encodeURIComponent(vaultId)}/notes/${encodeURIComponent(nodeId)}/backlinks`,
      { signal: ctrl.signal },
    )
      .then((r) => {
        if (r.status === 404) {
          // Endpoint not ready yet — graceful fallback
          dispatch({ type: 'backlinksSuccess', backlinks: [] });
          return null;
        }
        return r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`));
      })
      .then((j: { items?: BacklinkItem[] } | null) => {
        if (j) {
          dispatch({ type: 'backlinksSuccess', backlinks: j.items ?? [] });
        }
      })
      .catch((err) => {
        if ((err as Error).name === 'AbortError') return;
        dispatch({ type: 'backlinksError' });
      });

    return () => ctrl.abort();
  }, [nodeId, vaultId]);

  const fileName = nodeId ? nodeId.split('/').pop() ?? nodeId : '';
  const filePath = nodeId ?? '';

  const handleOpenFile = () => {
    if (!nodeId) return;
    setActiveFilePath(nodeId);
    setActiveTab('files');
    setSelectedSymbol(null);
    onClose();
  };

  const handleClose = () => {
    setSelectedSymbol(null);
    onClose();
  };

  const handleSelectBacklink = (fromNote: string) => {
    setSelectedSymbol(fromNote);
  };

  const isOpen = Boolean(nodeId);

  return (
    <>
      {/* Backdrop */}
      <div
        className={`absolute inset-0 z-20 bg-black/20 transition-opacity duration-300 ${
          isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={handleClose}
      />

      {/* Slide-over panel — theme-aware via CSS vars (graph-panel-bg / panel-border). */}
      <div
        className={`absolute top-0 right-0 bottom-0 z-30 w-80 backdrop-blur-md
                    border-l transition-transform duration-300 ease-out
                    flex flex-col ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
        style={{
          background: 'var(--graph-panel-bg, rgba(15,15,15,0.95))',
          borderColor: 'var(--graph-panel-border, rgba(255,255,255,0.05))',
          color: 'var(--color-text, #e8e8ed)',
        }}
      >
        {isOpen && (
          <>
            {/* Header */}
            <header
              className="flex items-start justify-between p-4 border-b"
              style={{ borderColor: 'var(--graph-panel-border, rgba(255,255,255,0.05))' }}
            >
              <div className="min-w-0 flex-1">
                <h3
                  className="text-sm font-semibold truncate"
                  style={{ color: 'var(--color-text, #e8e8ed)' }}
                  title={fileName}
                >
                  {fileName}
                </h3>
                <p
                  className="text-[11px] truncate mt-0.5"
                  style={{ color: 'var(--color-text-tertiary, rgba(255,255,255,0.3))' }}
                  title={filePath}
                >
                  {filePath}
                </p>
              </div>
              <button
                type="button"
                onClick={handleClose}
                className="ml-2 p-1.5 rounded-md transition-colors hover:bg-[var(--color-surface-hover)]"
                style={{ color: 'var(--color-text-tertiary, rgba(255,255,255,0.3))' }}
                aria-label={t('detail.closeLabel')}
              >
                <X className="w-4 h-4" />
              </button>
            </header>

            {/* Actions */}
            <div
              className="px-4 py-3 border-b"
              style={{ borderColor: 'var(--graph-panel-border, rgba(255,255,255,0.05))' }}
            >
              <button
                type="button"
                onClick={handleOpenFile}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg
                           border transition-colors text-xs font-medium
                           hover:bg-[var(--color-surface-hover)]"
                style={{
                  background: 'var(--color-surface, rgba(255,255,255,0.05))',
                  borderColor: 'var(--graph-panel-border, rgba(255,255,255,0.1))',
                  color: 'var(--color-text-secondary, rgba(255,255,255,0.7))',
                }}
              >
                <FileCode className="w-3.5 h-3.5" />
                {t('detail.goToFile', { defaultValue: 'Open in Editor' })}
                <ExternalLink className="w-3 h-3 opacity-50" />
              </button>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
              {/* Incoming / Callers */}
              <section>
                <div
                  className="text-[10px] uppercase tracking-wider mb-2"
                  style={{ color: 'var(--color-text-tertiary, rgba(255,255,255,0.3))' }}
                >
                  {t('detail.incoming')}
                </div>

                {state.loadingCallers ? (
                  <div className="text-xs animate-pulse" style={{ color: 'var(--color-text-tertiary)' }}>…</div>
                ) : state.errorCallers ? (
                  <div className="text-xs text-red-400/70">{t('detail.loadError')}</div>
                ) : !state.callers || state.callers.length === 0 ? (
                  <div className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{t('detail.noIncoming')}</div>
                ) : (
                  <ul className="space-y-1.5">
                    {state.callers.map((edge) => (
                      <li
                        key={`${edge.fromSymbol}:${edge.kind}:${edge.atLine}`}
                        className="flex items-start gap-1.5 text-xs group"
                      >
                        <ArrowLeft
                          className="w-3 h-3 flex-shrink-0 mt-0.5 transition-colors"
                          style={{ color: 'var(--color-text-tertiary)' }}
                        />
                        <div className="min-w-0">
                          <span className="font-medium" style={{ color: 'var(--color-text-tertiary)' }}>{edge.kind}</span>{' '}
                          <span className="font-mono truncate block" style={{ color: 'var(--color-text-secondary)' }}>
                            {edge.fromSymbol}
                          </span>
                          <span
                            className="font-mono text-[10px]"
                            style={{ color: 'var(--color-text-tertiary)' }}
                          >
                            :{edge.atLine}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Backlinks (wikilinks) */}
              <section>
                <div
                  className="text-[10px] uppercase tracking-wider mb-2"
                  style={{ color: 'var(--color-text-tertiary)' }}
                >
                  Backlinks
                </div>

                {state.loadingBacklinks ? (
                  <div className="text-xs animate-pulse" style={{ color: 'var(--color-text-tertiary)' }}>…</div>
                ) : state.errorBacklinks ? (
                  <div className="text-xs text-red-400/70">{t('detail.loadError')}</div>
                ) : !state.backlinks || state.backlinks.length === 0 ? (
                  <div className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>No backlinks</div>
                ) : (
                  <ul className="space-y-1.5">
                    {state.backlinks.map((bl) => (
                      <li key={bl.fromNote} className="flex items-start gap-1.5 text-xs group">
                        <Link2
                          className="w-3 h-3 flex-shrink-0 mt-0.5 transition-colors"
                          style={{ color: 'var(--color-text-tertiary)' }}
                        />
                        <button
                          type="button"
                          onClick={() => handleSelectBacklink(bl.fromNote)}
                          className="font-mono truncate text-left transition-colors"
                          style={{ color: 'var(--color-text-secondary)' }}
                        >
                          {bl.fromNote}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* AI Summary */}
              <section>
                <div
                  className="text-[10px] uppercase tracking-wider mb-2"
                  style={{ color: 'var(--color-text-tertiary)' }}
                >
                  AI Summary
                </div>

                {loadingSummary ? (
                  <div className="text-xs animate-pulse" style={{ color: 'var(--color-text-tertiary)' }}>Generating…</div>
                ) : summaryError ? (
                  <div className="text-xs text-red-400/70">Unable to generate summary</div>
                ) : summary ? (
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>{summary}</p>
                ) : (
                  <button
                    type="button"
                    onClick={handleSummarize}
                    className="text-xs transition-colors"
                    style={{ color: 'var(--color-text-tertiary)' }}
                  >
                    ✨ Summarize
                  </button>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </>
  );
}
