import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link2, List, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useVaultStore, type RightPanelTab } from '../../stores/vault-store';
import { parseNodeText, getKindStyle } from './graph/node-style';
import { useVaultFetch } from '../../hooks/useVaultFetch';
import { VaultEmptyState } from './VaultEmptyState';
import { OUTLINE_MAX_GROUPS, OUTLINE_MAX_ITEMS } from './constants';

interface VaultEdgeResponseItem {
  fromSymbol: string;
  toSymbol: string;
  kind: string;
  atLine: number;
}

interface OutlineRow {
  id: string;
  name: string;
  kind: string | null;
  file: string | null;
}

function TabButton({
  tab, active, onClick, icon: Icon, label,
}: {
  tab: RightPanelTab;
  active: boolean;
  onClick: (tab: RightPanelTab) => void;
  icon: typeof Link2;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onClick(tab)}
      className={cn(
        'flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-medium uppercase tracking-wider transition-colors',
        'border-b-2 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]/60',
        active
          ? 'border-[var(--color-accent)] text-[var(--color-text)]'
          : 'border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]',
      )}
    >
      <Icon className="w-3 h-3" />
      {label}
    </button>
  );
}

interface BacklinksProps {
  symbolId: string;
  vaultId: string;
}

function BacklinksSection({ symbolId, vaultId }: BacklinksProps) {
  const { t } = useTranslation('vault');
  const setSelectedSymbol = useVaultStore((s) => s.setSelectedSymbol);
  const setActiveTab = useVaultStore((s) => s.setActiveTab);

  const url = `/api/vaults/${encodeURIComponent(vaultId)}/symbols/${encodeURIComponent(symbolId)}/callers`;
  const { data, loading, error } = useVaultFetch<{ items?: VaultEdgeResponseItem[] }>(url);
  const callers = data?.items ?? null;

  if (loading) return <VaultEmptyState kind="loading" variant="inline" label="…" />;
  if (error) return <VaultEmptyState kind="error" variant="inline" label={t('detail.loadError')} />;
  if (!callers || callers.length === 0) {
    return <VaultEmptyState kind="empty" variant="inline" label={t('right.noBacklinks')} />;
  }

  return (
    <ul className="px-2 py-1 space-y-0.5">
      {callers.map((edge) => (
        <li key={`${edge.fromSymbol}:${edge.kind}:${edge.atLine}`}>
          <button
            type="button"
            onClick={() => {
              setSelectedSymbol(edge.fromSymbol);
              setActiveTab('graph');
            }}
            className="w-full text-left px-2 py-1 rounded text-xs hover:bg-[var(--color-surface-hover)] transition-colors group"
          >
            <div className="font-mono truncate">
              <span className="text-[var(--color-accent)]">{edge.kind}</span>{' '}
              <span className="text-[var(--color-text)] group-hover:text-[var(--color-accent)]">
                {edge.fromSymbol}
              </span>
              <span className="text-[var(--color-text-tertiary)]">:{edge.atLine}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function OutlineSection({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation('vault');
  const graph = useVaultStore((s) => s.graphCache[vaultId]);
  const setSelectedSymbol = useVaultStore((s) => s.setSelectedSymbol);
  const setActiveTab = useVaultStore((s) => s.setActiveTab);

  // Parse + group once per graph reference. Previously this ran on every
  // re-render of the right panel — on a 1k-symbol vault that's a visible
  // hitch each time another panel caused a parent re-render.
  const groups = useMemo(() => {
    if (!graph || graph.nodes.length === 0) return null;
    const rows: OutlineRow[] = graph.nodes.map((n) => {
      const parsed = parseNodeText(n.text);
      return {
        id: n.id,
        name: parsed.name,
        kind: n.kind ?? parsed.kind,
        file: n.file ?? parsed.file,
      };
    });
    const byFile = new Map<string, OutlineRow[]>();
    for (const row of rows) {
      const key = row.file ?? '—';
      const arr = byFile.get(key) ?? [];
      arr.push(row);
      byFile.set(key, arr);
    }
    return Array.from(byFile.entries());
  }, [graph]);

  if (!groups) {
    return <VaultEmptyState kind="empty" variant="inline" label={t('right.noOutline')} />;
  }

  return (
    <div className="px-1 py-1">
      {groups.slice(0, OUTLINE_MAX_GROUPS).map(([file, items]) => (
        <div key={file} className="mb-2">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)] font-mono truncate">
            {file}
          </div>
          <ul className="space-y-0.5">
            {items.slice(0, OUTLINE_MAX_ITEMS).map((row) => {
              const style = getKindStyle(row.kind);
              const Icon = style.icon;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedSymbol(row.id);
                      setActiveTab('graph');
                    }}
                    className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs hover:bg-[var(--color-surface-hover)] transition-colors"
                  >
                    <Icon className="w-3 h-3 flex-shrink-0" style={{ color: style.color }} />
                    <span className="truncate text-[var(--color-text-secondary)]">{row.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function MetadataSection({ vaultId, symbolId }: { vaultId: string; symbolId: string | null }) {
  const { t } = useTranslation('vault');
  const graph = useVaultStore((s) => s.graphCache[vaultId]);

  if (!symbolId) {
    return <VaultEmptyState kind="empty" variant="inline" label={t('right.empty')} />;
  }
  const node = graph?.nodes.find((n) => n.id === symbolId);
  if (!node) {
    return <VaultEmptyState kind="empty" variant="inline" label={t('right.noMetadata')} />;
  }
  const parsed = parseNodeText(node.text);
  const kind = node.kind ?? parsed.kind ?? 'unknown';

  const rows: [string, string][] = [
    ['kind', kind],
    ['name', parsed.name],
    ...(parsed.file ? [['file', parsed.file] as [string, string]] : []),
    ...(parsed.line != null ? [['line', String(parsed.line)] as [string, string]] : []),
    ['id', node.id],
  ];

  return (
    <dl className="px-3 py-2 text-xs space-y-1.5">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[80px_1fr] gap-2">
          <dt className="text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)] mt-0.5">
            {k}
          </dt>
          <dd className="font-mono text-[var(--color-text-secondary)] break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Obsidian-style right panel with Backlinks / Outline / Metadata tabs.
 */
export function RightPanel() {
  const { t } = useTranslation('vault');
  const activeRightTab = useVaultStore((s) => s.activeRightTab);
  const setActiveRightTab = useVaultStore((s) => s.setActiveRightTab);
  const selectedSymbolId = useVaultStore((s) => s.selectedSymbolId);
  const vaultId = useVaultStore((s) => s.selected);

  // Exhaustive Record for tab dispatch — replaces the nested-ternary ladder
  // that used to be right below (`activeRightTab === 'backlinks' ? … : …`).
  // The compiler now enforces a panel for every RightPanelTab value and each
  // panel is only constructed when it would actually render.
  let panel: ReactNode;
  if (!vaultId) {
    panel = <VaultEmptyState kind="no-vault" variant="inline" label={t('files.selectVault')} />;
  } else {
    const panels: Record<RightPanelTab, ReactNode> = {
      backlinks: selectedSymbolId
        ? <BacklinksSection symbolId={selectedSymbolId} vaultId={vaultId} />
        : <VaultEmptyState kind="empty" variant="inline" label={t('right.empty')} />,
      outline: <OutlineSection vaultId={vaultId} />,
      metadata: <MetadataSection vaultId={vaultId} symbolId={selectedSymbolId} />,
    };
    panel = panels[activeRightTab];
  }

  return (
    <aside
      className="h-full flex flex-col bg-[var(--color-bg-secondary)]"
      role="region"
      aria-label={t('detail.title')}
    >
      <div role="tablist" className="flex border-b border-[var(--color-border-subtle)]">
        <TabButton tab="backlinks" active={activeRightTab === 'backlinks'} onClick={setActiveRightTab} icon={Link2} label={t('right.backlinks')} />
        <TabButton tab="outline" active={activeRightTab === 'outline'} onClick={setActiveRightTab} icon={List} label={t('right.outline')} />
        <TabButton tab="metadata" active={activeRightTab === 'metadata'} onClick={setActiveRightTab} icon={Info} label={t('right.metadata')} />
      </div>
      <div className="flex-1 overflow-auto">{panel}</div>
    </aside>
  );
}

export default RightPanel;
