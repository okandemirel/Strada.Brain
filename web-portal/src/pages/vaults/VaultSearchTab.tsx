import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search as SearchIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { useVaultStore } from '../../stores/vault-store';
import { VaultEmptyState } from './VaultEmptyState';
import { apiFetch } from '../../utils/api'

/**
 * Semantic + keyword hybrid search, Obsidian-search-pane-style.
 */
export default function VaultSearchTab() {
  const { t } = useTranslation('vault');
  const selected = useVaultStore((s) => s.selected);
  const searchResults = useVaultStore((s) => s.searchResults);
  const setSearchResults = useVaultStore((s) => s.setSearchResults);
  const setActiveFilePath = useVaultStore((s) => s.setActiveFilePath);
  const setActiveTab = useVaultStore((s) => s.setActiveTab);

  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestSeqRef = useRef(0);

  const run = async () => {
    if (!selected || !text.trim()) return;
    const seq = ++requestSeqRef.current;
    const vaultId = selected;
    // Only the newest query, for the vault still selected, may write results:
    // a slow answer for vault A used to land under vault B (WEB-22).
    const stillCurrent = () => seq === requestSeqRef.current && useVaultStore.getState().selected === vaultId;
    setLoading(true);
    setSubmitted(true);
    setFailed(false);
    try {
      const res = await apiFetch(`/api/vaults/${encodeURIComponent(vaultId)}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, topK: 20 }),
      });
      // An error answer is a failure, not "no matches".
      if (!res.ok) throw new Error(`vault search failed: ${res.status}`);
      const data = await res.json();
      if (!stillCurrent()) return;
      setSearchResults(Array.isArray(data?.hits) ? data.hits : []);
    } catch {
      if (!stillCurrent()) return;
      setSearchResults([]);
      setFailed(true);
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  };

  if (!selected) {
    return <VaultEmptyState kind="no-vault" label={t('search.selectVault')} />;
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-[var(--color-border-subtle)]">
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-tertiary)]" />
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
            placeholder={t('search.placeholder')}
            aria-label={t('search.placeholder')}
            className="h-9 pl-9 pr-24 text-sm bg-[var(--color-bg)] border-[var(--color-border-subtle)]"
          />
          <button
            type="button"
            onClick={run}
            disabled={!text.trim() || loading}
            className={cn(
              'absolute right-1 top-1/2 -translate-y-1/2 px-3 h-7 text-xs rounded-md',
              'bg-[var(--color-accent)]/90 text-black hover:bg-[var(--color-accent)] transition-colors',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {loading ? t('search.running') : t('search.run')}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {!submitted ? (
          <VaultEmptyState kind="empty" label={t('search.empty')} />
        ) : failed ? (
          <VaultEmptyState kind="error" label={t('search.failed')} onRetry={run} retryLabel={t('search.run')} />
        ) : searchResults.length === 0 ? (
          <VaultEmptyState kind="no-match" label={t('empty.noMatches')} />
        ) : (
          <ul className="divide-y divide-[var(--color-border-subtle)]">
            {searchResults.map((h) => (
              <li key={h.chunk.chunkId}>
                <button
                  type="button"
                  onClick={() => {
                    setActiveFilePath(h.chunk.path);
                    setActiveTab('files');
                  }}
                  className="w-full text-left px-4 py-3 hover:bg-[var(--color-surface-hover)] transition-colors"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <code className="text-xs font-mono text-[var(--color-accent)] truncate">
                      {h.chunk.path}:{h.chunk.startLine}-{h.chunk.endLine}
                    </code>
                    <span className="text-[10px] text-[var(--color-text-tertiary)] flex-shrink-0">
                      rrf={h.scores.rrf.toFixed(3)}
                    </span>
                  </div>
                  <pre className="mt-1.5 text-[12px] whitespace-pre-wrap break-words text-[var(--color-text-secondary)] font-mono leading-snug line-clamp-4">
                    {h.chunk.content}
                  </pre>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
