import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileCode2 } from 'lucide-react';
import { useVaultStore } from '../../stores/vault-store';
import MarkdownPreview from './MarkdownPreview';

/**
 * Center reader for the Files tab. Reads `selected` + `activeFilePath` from
 * the vault store; the file tree lives in the left sidebar (FileTreeSidebar).
 */
export default function VaultFilesTab() {
  const { t } = useTranslation('vault');
  const selected = useVaultStore((s) => s.selected);
  const path = useVaultStore((s) => s.activeFilePath);

  const [body, setBody] = useState<string>('');
  const [loading, setLoading] = useState(false);

  // Reset body during render when the open file changes — gives an immediate
  // blank-then-loading flash instead of flashing the previous file.
  const [prevKey, setPrevKey] = useState<string>(`${selected ?? ''}::${path ?? ''}`);
  const key = `${selected ?? ''}::${path ?? ''}`;
  if (key !== prevKey) {
    setPrevKey(key);
    setBody('');
    setLoading(Boolean(selected && path));
  }

  useEffect(() => {
    if (!selected || !path) return;
    const ctrl = new AbortController();
    fetch(`/api/vaults/${encodeURIComponent(selected)}/file?path=${encodeURIComponent(path)}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { body?: string }) => setBody(d.body ?? ''))
      .catch((err) => {
        if ((err as Error).name !== 'AbortError') setBody('');
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [selected, path]);

  if (!selected) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-[var(--color-text-tertiary)]">
        {t('files.selectVault')}
      </div>
    );
  }
  if (!path) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-[var(--color-text-tertiary)]">
        <FileCode2 className="w-8 h-8 opacity-40" />
        <div className="text-sm">{t('files.pickFile')}</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      {loading ? (
        <div className="p-6 text-sm text-[var(--color-text-tertiary)] animate-pulse">…</div>
      ) : path.endsWith('.md') ? (
        <div className="p-6 max-w-4xl mx-auto">
          <MarkdownPreview source={body} />
        </div>
      ) : (
        <pre className="p-6 text-[13px] whitespace-pre-wrap font-mono text-[var(--color-text-secondary)] leading-relaxed">
          {body}
        </pre>
      )}
    </div>
  );
}
