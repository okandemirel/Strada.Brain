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

      {/* Slide-over panel */}
      <div
        className={`absolute top-0 right-0 bottom-0 z-30 w-80 bg-[#0f0f0f]/95 backdrop-blur-md
                    border-l border-white/5 transition-transform duration-300 ease-out
                    flex flex-col ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {isOpen && (
          <>
            {/* Header */}
            <header className="flex items-start justify-between p-4 border-b border-white/5">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-white truncate" title={fileName}>
                  {fileName}
                </h3>
                <p className="text-[11px] text-white/30 truncate mt-0.5" title={filePath}>
                  {filePath}
                </p>
              </div>
              <button
                type="button"
                onClick={handleClose}
                className="ml-2 p-1.5 rounded-md text-white/30 hover:text-white/70 hover:bg-white/5 transition-colors"
                aria-label={t('detail.closeLabel')}
              >
                <X className="w-4 h-4" />
              </button>
            </header>

            {/* Actions */}
            <div className="px-4 py-3 border-b border-white/5">
              <button
                type="button"
                onClick={handleOpenFile}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg
                           bg-white/5 hover:bg-white/10 text-white/70 hover:text-white
                           border border-white/10 transition-colors text-xs font-medium"
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
                <div className="text-[10px] uppercase tracking-wider text-white/20 mb-2">
                  {t('detail.incoming')}
                </div>

                {state.loadingCallers ? (
                  <div className="text-xs text-white/30 animate-pulse">…</div>
                ) : state.errorCallers ? (
                  <div className="text-xs text-red-400/70">{t('detail.loadError')}</div>
                ) : !state.callers || state.callers.length === 0 ? (
                  <div className="text-xs text-white/20">{t('detail.noIncoming')}</div>
                ) : (
                  <ul className="space-y-1.5">
                    {state.callers.map((edge) => (
                      <li
                        key={`${edge.fromSymbol}:${edge.kind}:${edge.atLine}`}
                        className="flex items-start gap-1.5 text-xs group"
                      >
                        <ArrowLeft className="w-3 h-3 text-white/20 flex-shrink-0 mt-0.5 group-hover:text-white/40 transition-colors" />
                        <div className="min-w-0">
                          <span className="text-white/40 font-medium">{edge.kind}</span>{' '}
                          <span className="text-white/60 font-mono truncate block">
                            {edge.fromSymbol}
                          </span>
                          <span className="text-white/20 font-mono text-[10px]">
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
                <div className="text-[10px] uppercase tracking-wider text-white/20 mb-2">
                  Backlinks
                </div>

                {state.loadingBacklinks ? (
                  <div className="text-xs text-white/30 animate-pulse">…</div>
                ) : state.errorBacklinks ? (
                  <div className="text-xs text-red-400/70">{t('detail.loadError')}</div>
                ) : !state.backlinks || state.backlinks.length === 0 ? (
                  <div className="text-xs text-white/20">No backlinks</div>
                ) : (
                  <ul className="space-y-1.5">
                    {state.backlinks.map((bl) => (
                      <li key={bl.fromNote} className="flex items-start gap-1.5 text-xs group">
                        <Link2 className="w-3 h-3 text-white/20 flex-shrink-0 mt-0.5 group-hover:text-white/40 transition-colors" />
                        <button
                          type="button"
                          onClick={() => handleSelectBacklink(bl.fromNote)}
                          className="text-white/60 hover:text-white/90 font-mono truncate text-left transition-colors"
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
                <div className="text-[10px] uppercase tracking-wider text-white/20 mb-2">
                  AI Summary
                </div>

                {loadingSummary ? (
                  <div className="text-xs text-white/30 animate-pulse">Generating…</div>
                ) : summaryError ? (
                  <div className="text-xs text-red-400/70">Unable to generate summary</div>
                ) : summary ? (
                  <p className="text-xs text-white/60 leading-relaxed">{summary}</p>
                ) : (
                  <button
                    type="button"
                    onClick={handleSummarize}
                    className="text-xs text-white/40 hover:text-white/80 transition-colors"
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
