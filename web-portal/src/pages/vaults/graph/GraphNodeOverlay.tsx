import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, FileCode, ExternalLink, ArrowLeft } from 'lucide-react';
import { useVaultStore } from '../../../stores/vault-store';

interface VaultEdgeResponseItem {
  fromSymbol: string;
  toSymbol: string;
  kind: string;
  atLine: number;
}

interface Props {
  nodeId: string | null;
  onClose: () => void;
}

export function GraphNodeOverlay({ nodeId, onClose }: Props) {
  const { t } = useTranslation('vault');
  const vaultId = useVaultStore((s) => s.selected);
  const setActiveFilePath = useVaultStore((s) => s.setActiveFilePath);
  const setActiveTab = useVaultStore((s) => s.setActiveTab);
  const setSelectedSymbol = useVaultStore((s) => s.setSelectedSymbol);
  const [callers, setCallers] = useState<VaultEdgeResponseItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setCallers(null);
    setError(false);
    setLoading(Boolean(nodeId && vaultId));
    if (!nodeId || !vaultId) return;
    const ctrl = new AbortController();
    fetch(
      `/api/vaults/${encodeURIComponent(vaultId)}/symbols/${encodeURIComponent(nodeId)}/callers`,
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
  }, [nodeId, vaultId]);

  // Parse nodeId as file path for display
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

            {/* Backlinks / Callers */}
            <div className="flex-1 overflow-y-auto px-4 py-3">
              <div className="text-[10px] uppercase tracking-wider text-white/20 mb-2">
                {t('detail.incoming')}
              </div>

              {loading ? (
                <div className="text-xs text-white/30 animate-pulse">…</div>
              ) : error ? (
                <div className="text-xs text-red-400/70">{t('detail.loadError')}</div>
              ) : !callers || callers.length === 0 ? (
                <div className="text-xs text-white/20">{t('detail.noIncoming')}</div>
              ) : (
                <ul className="space-y-1.5">
                  {callers.map((edge) => (
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
            </div>
          </>
        )}
      </div>
    </>
  );
}
