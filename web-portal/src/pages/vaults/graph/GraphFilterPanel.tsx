import { useTranslation } from 'react-i18next';
import { FileText, RotateCcw, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import {
  ALL_SYMBOL_KINDS,
  useVaultStore,
  type SymbolKind,
} from '../../../stores/vault-store';
import { KIND_STYLE_MAP } from './node-style';

interface Props {
  /** How many nodes pass current filters. */
  visibleCount: number;
  /** Total nodes in the current canvas. */
  totalCount: number;
}

export function GraphFilterPanel({ visibleCount, totalCount }: Props) {
  const { t } = useTranslation('vault');
  const filters = useVaultStore((s) => s.graphFilters);
  const toggleKind = useVaultStore((s) => s.toggleGraphKind);
  const setSearch = useVaultStore((s) => s.setGraphSearch);
  const setFileFilter = useVaultStore((s) => s.setGraphFileFilter);
  const reset = useVaultStore((s) => s.resetGraphFilters);

  return (
    <aside
      className="h-full flex flex-col gap-3 p-3 overflow-y-auto text-sm bg-[var(--graph-panel-bg)] border-r border-[var(--graph-panel-border)]"
      aria-label={t('filter.title')}
    >
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-[11px] uppercase tracking-wider text-muted-foreground">
          {t('filter.title')}
        </h3>
        <button
          type="button"
          onClick={reset}
          className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition"
          aria-label={t('filter.reset')}
        >
          <RotateCcw className="w-3 h-3" />
          {t('filter.reset')}
        </button>
      </div>

      <label className="relative block">
        <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          type="text"
          value={filters.search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('filter.search.placeholder')}
          className="pl-7 h-8 text-xs"
          aria-label={t('filter.search.placeholder')}
          maxLength={256}
        />
      </label>

      <label className="relative block">
        <FileText className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          type="text"
          value={filters.fileFilter}
          onChange={(e) => setFileFilter(e.target.value)}
          placeholder={t('filter.file.placeholder')}
          className="pl-7 h-8 text-xs"
          aria-label={t('filter.file.placeholder')}
          maxLength={256}
        />
      </label>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
          {t('filter.kinds')}
        </div>
        <ul className="space-y-0.5">
          {ALL_SYMBOL_KINDS.map((kind: SymbolKind) => {
            const style = KIND_STYLE_MAP[kind];
            const Icon = style.icon;
            const enabled = filters.kinds[kind];
            return (
              <li key={kind}>
                <button
                  type="button"
                  onClick={() => toggleKind(kind)}
                  className={cn(
                    'group w-full flex items-center gap-2 px-1.5 py-1 rounded transition-all',
                    'hover:bg-[var(--graph-node-surface-hover)]',
                    !enabled && 'opacity-50 grayscale',
                  )}
                  aria-pressed={enabled}
                >
                  <span
                    className="relative flex items-center justify-center w-4 h-4 rounded transition-colors"
                    style={{
                      backgroundColor: enabled ? style.color : 'transparent',
                      border: `1.5px solid ${style.color}`,
                    }}
                  >
                    {enabled && <Icon className="w-2.5 h-2.5" style={{ color: '#000' }} />}
                  </span>
                  <span className="flex-1 text-left text-xs text-foreground">
                    {t(`filter.kind.${kind}`, { defaultValue: style.label })}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="mt-auto pt-2 border-t border-[var(--graph-panel-border)] text-[10px] text-muted-foreground">
        {t('filter.resultCount', { visible: visibleCount, total: totalCount })}
      </div>
    </aside>
  );
}
