import { useTranslation } from 'react-i18next';
import { Database, Package } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useVaultStore } from '../../stores/vault-store';

export default function VaultList() {
  const { t } = useTranslation('vault');
  const vaults = useVaultStore((s) => s.vaults);
  const selected = useVaultStore((s) => s.selected);
  const select = useVaultStore((s) => s.select);

  if (vaults.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 h-full p-6 text-center">
        <Database className="w-7 h-7 text-[var(--color-text-tertiary)] opacity-50" />
        <div className="text-xs text-[var(--color-text-tertiary)]">
          {t('vaultList.empty')}
        </div>
      </div>
    );
  }

  return (
    <ul className="p-1.5 space-y-0.5">
      {vaults.map((v) => {
        const active = selected === v.id;
        return (
          <li key={v.id}>
            <button
              type="button"
              onClick={() => select(v.id)}
              className={cn(
                'w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left transition-colors',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]/60',
                active
                  ? 'bg-[var(--color-surface-hover)] text-[var(--color-text)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]/60',
              )}
              aria-pressed={active}
            >
              <Package
                className={cn(
                  'w-3.5 h-3.5 mt-0.5 flex-shrink-0',
                  active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-tertiary)]',
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium truncate">{v.id}</div>
                <div className="text-[10px] text-[var(--color-text-tertiary)] truncate">
                  {v.kind}
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
