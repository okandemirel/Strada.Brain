import { lazy, Suspense, useEffect, useMemo, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FolderOpen,
  Search,
  Share2,
  Bookmark,
  Settings as SettingsIcon,
  X as CloseIcon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import VaultList from './vaults/VaultList';
import VaultFilesTab from './vaults/VaultFilesTab';
import VaultSearchTab from './vaults/VaultSearchTab';
import { FileTreeSidebar } from './vaults/FileTreeSidebar';
import { VaultStatusBar } from './vaults/VaultStatusBar';
import { VaultEmptyState } from './vaults/VaultEmptyState';
import { TABLET_BREAKPOINT_PX } from './vaults/constants';
import { useVaultFetch } from '../hooks/useVaultFetch';
import { useVaultStore, type VaultTab } from '../stores/vault-store';

// Graph tab pulls in @xyflow/react + d3-force; defer to keep initial bundle lean.
const VaultGraphTab = lazy(() => import('./vaults/VaultGraphTab'));
// RightPanel + CommandPalette are only visible once the user has interacted
// with the workspace. Defer both to keep the initial Vaults route chunk lean
// and let the bundler emit them as separate chunks (see vite.config.ts).
const RightPanel = lazy(() =>
  import('./vaults/RightPanel').then((m) => ({ default: m.RightPanel })),
);
const CommandPalette = lazy(() =>
  import('../components/CommandPalette').then((m) => ({ default: m.CommandPalette })),
);

interface RailItem {
  tab: VaultTab;
  icon: LucideIcon;
  labelKey: string;
}

const RAIL_ITEMS: RailItem[] = [
  { tab: 'files', icon: FolderOpen, labelKey: 'rail.files' },
  { tab: 'search', icon: Search, labelKey: 'rail.search' },
  { tab: 'graph', icon: Share2, labelKey: 'rail.graph' },
  { tab: 'bookmarks', icon: Bookmark, labelKey: 'rail.bookmarks' },
];

/**
 * Obsidian-style Vault workspace:
 *  [ Icon Rail | Left Panel (VaultList + per-tab sidebar) | Center (tab bar + content) | Right Panel ]
 *  [ Status Bar                                                                                      ]
 *
 * Keyboard:
 *   Cmd/Ctrl+B       — toggle left panel
 *   Cmd/Ctrl+Shift+B — toggle right panel
 *   Cmd/Ctrl+P / Cmd/Ctrl+O — open command palette / quick switcher
 *   Cmd/Ctrl+1..3    — jump to Files/Search/Graph tab
 */
export default function VaultsPage() {
  const { t } = useTranslation('vault');

  const setVaults = useVaultStore((s) => s.setVaults);
  const selected = useVaultStore((s) => s.selected);
  const activeTab = useVaultStore((s) => s.activeTab);
  const setActiveTab = useVaultStore((s) => s.setActiveTab);
  const activeFilePath = useVaultStore((s) => s.activeFilePath);
  const setActiveFilePath = useVaultStore((s) => s.setActiveFilePath);
  const leftPanelOpen = useVaultStore((s) => s.leftPanelOpen);
  const rightPanelOpen = useVaultStore((s) => s.rightPanelOpen);
  const toggleLeftPanel = useVaultStore((s) => s.toggleLeftPanel);
  const toggleRightPanel = useVaultStore((s) => s.toggleRightPanel);
  const setRightPanelOpen = useVaultStore((s) => s.setRightPanelOpen);
  const setCommandPaletteOpen = useVaultStore((s) => s.setCommandPaletteOpen);

  // Vault list fetch — shared hook handles abort + error fallback identically
  // to the four other vault endpoints in this page. We only mirror into the
  // store once a response (or error) arrives so a null `data` during the
  // initial render doesn't clobber state pre-seeded by tests.
  const {
    data: vaultList,
    loading: vaultListLoading,
    error: vaultListError,
  } = useVaultFetch<{ items?: { id: string; kind: string }[] }>('/api/vaults');
  useEffect(() => {
    if (vaultListLoading) return;
    if (vaultList) setVaults(vaultList.items ?? []);
    else if (vaultListError) setVaults([]);
  }, [vaultList, vaultListLoading, vaultListError, setVaults]);

  // Auto-collapse right panel on narrow viewports on first mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.innerWidth < TABLET_BREAKPOINT_PX) setRightPanelOpen(false);
    // intentionally run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'p' || key === 'o') {
        e.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if (e.shiftKey && key === 'b') {
        e.preventDefault();
        toggleRightPanel();
        return;
      }
      if (key === 'b') {
        e.preventDefault();
        toggleLeftPanel();
        return;
      }
      if (key === '1') { e.preventDefault(); setActiveTab('files'); return; }
      if (key === '2') { e.preventDefault(); setActiveTab('search'); return; }
      if (key === '3') { e.preventDefault(); setActiveTab('graph'); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setCommandPaletteOpen, toggleLeftPanel, toggleRightPanel, setActiveTab]);

  // Open tabs list — derived from current state so it always reflects reality.
  const openTabs = useMemo(() => {
    const tabs: { tab: VaultTab; label: string; icon: LucideIcon; closable: boolean; subtitle?: string }[] = [];
    tabs.push({ tab: 'files', label: t('tab.files'), icon: FolderOpen, closable: false, subtitle: activeFilePath ?? undefined });
    tabs.push({ tab: 'search', label: t('tab.search'), icon: Search, closable: false });
    tabs.push({ tab: 'graph', label: t('tab.graph'), icon: Share2, closable: false });
    return tabs;
  }, [t, activeFilePath]);

  const handleCloseFileTab = useCallback(() => setActiveFilePath(null), [setActiveFilePath]);

  // Exhaustive tab-dispatch tables. Keeping these as full Records forces the
  // type-checker to wire up every VaultTab value, so future additions can't
  // silently fall through to the `else` branch (which was the bug the prior
  // nested ternary was one indent-mistake away from shipping).
  const leftPanelByTab: Record<VaultTab, ReactNode> = useMemo(() => ({
    files: <FileTreeSidebar />,
    search: <div className="h-full p-3 text-xs text-[var(--color-text-tertiary)]">{t('rail.search')}</div>,
    graph: <div className="h-full p-3 text-xs text-[var(--color-text-tertiary)]">{t('rail.graph')}</div>,
    bookmarks: <div className="h-full p-3 text-xs text-[var(--color-text-tertiary)]">{t('rail.bookmarks')}</div>,
  }), [t]);

  const graphLoading = (
    <div className="p-4 text-sm text-[var(--color-text-tertiary)]">{t('empty.loading')}</div>
  );
  const tabPanels: Record<VaultTab, ReactNode> = useMemo(() => ({
    files: <VaultFilesTab />,
    search: <VaultSearchTab />,
    graph: (
      <Suspense fallback={graphLoading}>
        <VaultGraphTab />
      </Suspense>
    ),
    bookmarks: (
      <VaultEmptyState kind="empty" label={t('rail.bookmarks')} />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [t]);

  const breadcrumbs = useMemo(() => {
    const parts: string[] = [];
    if (selected) parts.push(selected);
    if (activeTab === 'files' && activeFilePath) {
      for (const seg of activeFilePath.split('/').filter(Boolean)) parts.push(seg);
    } else if (activeTab === 'search') {
      parts.push(t('tab.search'));
    } else if (activeTab === 'graph') {
      parts.push(t('tab.graph'));
    }
    return parts;
  }, [selected, activeTab, activeFilePath, t]);

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="flex-1 min-h-0 flex">
        {/* Icon Rail (fixed 48px) */}
        <nav
          className="w-12 flex-shrink-0 flex flex-col items-center py-2 bg-[var(--color-bg-secondary)] border-r border-[var(--color-border-subtle)]"
          aria-label="Vault navigation rail"
        >
          {RAIL_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.tab;
            return (
              <button
                key={item.tab}
                type="button"
                onClick={() => setActiveTab(item.tab)}
                className={cn(
                  'relative w-9 h-9 my-0.5 flex items-center justify-center rounded-md transition-colors',
                  'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]/70',
                  active
                    ? 'text-[var(--color-text)] bg-[var(--color-surface-hover)]'
                    : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]/50',
                )}
                title={t(item.labelKey)}
                aria-label={t(item.labelKey)}
                aria-pressed={active}
              >
                {active && (
                  <span
                    aria-hidden
                    className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r bg-[var(--color-accent)]"
                  />
                )}
                <Icon className="w-[18px] h-[18px]" />
              </button>
            );
          })}
          <div className="flex-1" />
          <button
            type="button"
            className="w-9 h-9 my-0.5 flex items-center justify-center rounded-md text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]/50 transition-colors"
            title={t('rail.settings')}
            aria-label={t('rail.settings')}
            disabled
          >
            <SettingsIcon className="w-[18px] h-[18px] opacity-50" />
          </button>
        </nav>

        {/* Resizable tri-panel */}
        <div className="flex-1 min-w-0">
          <ResizablePanelGroup direction="horizontal" className="h-full w-full">
            {leftPanelOpen && (
              <>
                <ResizablePanel
                  id="vault-left"
                  order={1}
                  defaultSize={20}
                  minSize={14}
                  maxSize={32}
                  className="bg-[var(--color-bg-secondary)]"
                >
                  <div className="h-full flex flex-col border-r border-[var(--color-border-subtle)]">
                    <div className="px-3 py-2 border-b border-[var(--color-border-subtle)] flex items-center justify-between">
                      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                        {t('vaultList.title')}
                      </h2>
                    </div>
                    <div className="max-h-[40%] overflow-auto border-b border-[var(--color-border-subtle)]">
                      <VaultList />
                    </div>
                    <div className="flex-1 min-h-0">{leftPanelByTab[activeTab]}</div>
                  </div>
                </ResizablePanel>
                <ResizableHandle className="w-px bg-[var(--color-border-subtle)]" />
              </>
            )}

            <ResizablePanel id="vault-center" order={2} defaultSize={rightPanelOpen ? 55 : 80} minSize={30}>
              <div className="h-full flex flex-col min-w-0 bg-[var(--color-bg)]">
                {/* Tab bar */}
                <div className="flex items-stretch border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]">
                  <div className="flex-1 flex items-stretch overflow-x-auto">
                    {openTabs.map((ot) => {
                      const Icon = ot.icon;
                      const active = activeTab === ot.tab;
                      const showCloseBtn = ot.tab === 'files' && Boolean(activeFilePath);
                      // Tabs with a close affordance cannot be a single <button>
                      // (nested interactive controls are invalid HTML). Wrap in
                      // a div and render two sibling buttons instead.
                      return (
                        <div
                          key={ot.tab}
                          className={cn(
                            'group flex items-stretch border-r border-[var(--color-border-subtle)] transition-colors',
                            active
                              ? 'bg-[var(--color-bg)] text-[var(--color-text)]'
                              : 'bg-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]/50',
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => setActiveTab(ot.tab)}
                            onKeyDown={(e) => {
                              // Delete/Backspace on the focused files tab closes the open file.
                              if (showCloseBtn && active && (e.key === 'Delete' || e.key === 'Backspace')) {
                                e.preventDefault();
                                handleCloseFileTab();
                              }
                            }}
                            className="flex items-center gap-1.5 px-3 h-9 text-xs focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]/60"
                            aria-pressed={active}
                          >
                            <Icon className={cn('w-3.5 h-3.5', active && 'text-[var(--color-accent)]')} />
                            <span className="truncate max-w-[180px]">{ot.label}</span>
                            {showCloseBtn && (
                              <>
                                <span className="opacity-40">·</span>
                                <span className="truncate max-w-[200px] text-[var(--color-text-secondary)] font-mono">
                                  {activeFilePath!.split('/').pop()}
                                </span>
                              </>
                            )}
                          </button>
                          {showCloseBtn && (
                            <button
                              type="button"
                              onClick={handleCloseFileTab}
                              aria-label={t('tab.close')}
                              className={cn(
                                'flex items-center px-1 mr-1 my-auto rounded hover:bg-[var(--color-surface-hover)]',
                                'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity',
                                'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]/60',
                              )}
                            >
                              <CloseIcon className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center px-2 gap-1">
                    <button
                      type="button"
                      onClick={toggleLeftPanel}
                      className="p-1.5 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors"
                      title={t('panel.toggleLeft')}
                      aria-label={t('panel.toggleLeft')}
                    >
                      {leftPanelOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
                    </button>
                    <button
                      type="button"
                      onClick={toggleRightPanel}
                      className="p-1.5 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors"
                      title={t('panel.toggleRight')}
                      aria-label={t('panel.toggleRight')}
                    >
                      {rightPanelOpen ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Breadcrumbs */}
                {breadcrumbs.length > 0 && (
                  <div className="flex items-center gap-1 px-3 py-1.5 text-[11px] text-[var(--color-text-tertiary)] border-b border-[var(--color-border-subtle)] bg-[var(--color-bg)] overflow-x-auto">
                    <span className="text-[var(--color-text-secondary)]">{t('breadcrumb.root')}</span>
                    {breadcrumbs.map((p, i) => (
                      <span key={`${p}-${i}`} className="flex items-center gap-1 min-w-0">
                        <ChevronRight className="w-3 h-3 opacity-50 flex-shrink-0" />
                        <span
                          className={cn(
                            'truncate',
                            i === breadcrumbs.length - 1 && 'text-[var(--color-text-secondary)]',
                          )}
                          title={p}
                        >
                          {p}
                        </span>
                      </span>
                    ))}
                  </div>
                )}

                {/* Tab content — exhaustive Record keeps the switch type-safe
                    and collapses a 4-branch ternary ladder into a table. */}
                <section className="flex-1 overflow-hidden min-h-0" role="tabpanel">
                  {tabPanels[activeTab]}
                </section>
              </div>
            </ResizablePanel>

            {rightPanelOpen && (
              <>
                <ResizableHandle className="w-px bg-[var(--color-border-subtle)]" />
                <ResizablePanel
                  id="vault-right"
                  order={3}
                  defaultSize={22}
                  minSize={16}
                  maxSize={34}
                  className="bg-[var(--color-bg-secondary)]"
                >
                  <div className="h-full border-l border-[var(--color-border-subtle)]">
                    <Suspense fallback={null}>
                      <RightPanel />
                    </Suspense>
                  </div>
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </div>
      </div>

      {/* Status bar */}
      <VaultStatusBar />

      {/* Command palette (global) — loaded lazily; the Dialog only mounts on
          first open so the Suspense fallback is effectively invisible. */}
      <Suspense fallback={null}>
        <CommandPalette />
      </Suspense>
    </div>
  );
}
