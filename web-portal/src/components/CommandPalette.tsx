import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FolderOpen,
  Search,
  Share2,
  RefreshCw,
  FilterX,
  PanelLeft,
  PanelRight,
  ArrowRightCircle,
  type LucideIcon,
} from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useVaultStore } from '../stores/vault-store';
import { MAX_RECENT_COMMANDS } from '../pages/vaults/constants';
import { fuzzyMatch } from '../lib/fuzzy';

interface Command {
  id: string;
  category: string;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  run: () => void;
}

/**
 * Cross-platform shortcut label (Cmd on mac, Ctrl elsewhere).
 */
function modKey(): string {
  if (typeof navigator === 'undefined') return 'Ctrl';
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? '⌘' : 'Ctrl';
}

export function CommandPalette() {
  const { t } = useTranslation('vault');
  const open = useVaultStore((s) => s.commandPaletteOpen);
  const setOpen = useVaultStore((s) => s.setCommandPaletteOpen);
  const setActiveTab = useVaultStore((s) => s.setActiveTab);
  const toggleLeftPanel = useVaultStore((s) => s.toggleLeftPanel);
  const toggleRightPanel = useVaultStore((s) => s.toggleRightPanel);
  const resetGraphFilters = useVaultStore((s) => s.resetGraphFilters);
  const clearGraph = useVaultStore((s) => s.clearGraph);
  const selected = useVaultStore((s) => s.selected);
  const recentSymbols = useVaultStore((s) => s.recentSymbols);
  const recentFiles = useVaultStore((s) => s.recentFiles);
  const setSelectedSymbol = useVaultStore((s) => s.setSelectedSymbol);
  const setActiveFilePath = useVaultStore((s) => s.setActiveFilePath);

  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset query + cursor each time the palette opens. `prevOpen` drives a
  // during-render reset so we don't violate react-hooks/set-state-in-effect.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setQuery('');
      setIndex(0);
    }
  }

  useEffect(() => {
    if (!open) return;
    // Focus after dialog mount (DOM sync — permitted in effects).
    const id = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [open]);

  const mod = modKey();

  const commands: Command[] = useMemo(() => {
    const close = () => setOpen(false);
    const navCmds: Command[] = [
      {
        id: 'go-files', category: t('palette.category.nav'), label: t('palette.cmd.goFiles'),
        icon: FolderOpen, shortcut: `${mod}+1`,
        run: () => { setActiveTab('files'); close(); },
      },
      {
        id: 'go-search', category: t('palette.category.nav'), label: t('palette.cmd.goSearch'),
        icon: Search, shortcut: `${mod}+2`,
        run: () => { setActiveTab('search'); close(); },
      },
      {
        id: 'go-graph', category: t('palette.category.nav'), label: t('palette.cmd.goGraph'),
        icon: Share2, shortcut: `${mod}+3`,
        run: () => { setActiveTab('graph'); close(); },
      },
    ];
    const vaultCmds: Command[] = [
      {
        id: 'reindex', category: t('palette.category.vault'), label: t('palette.cmd.reindex'),
        icon: RefreshCw,
        run: () => { if (selected) clearGraph(selected); close(); },
      },
      {
        id: 'clear-filters', category: t('palette.category.vault'), label: t('palette.cmd.clearFilters'),
        icon: FilterX,
        run: () => { resetGraphFilters(); close(); },
      },
    ];
    const viewCmds: Command[] = [
      {
        id: 'toggle-left', category: t('palette.category.view'), label: t('palette.cmd.toggleLeft'),
        icon: PanelLeft, shortcut: `${mod}+B`,
        run: () => { toggleLeftPanel(); close(); },
      },
      {
        id: 'toggle-right', category: t('palette.category.view'), label: t('palette.cmd.toggleRight'),
        icon: PanelRight, shortcut: `${mod}+Shift+B`,
        run: () => { toggleRightPanel(); close(); },
      },
    ];
    const recentCmds: Command[] = [];
    // Keep recent-item count aligned with MAX_RECENT_COMMANDS so the palette
    // and the store's cap stay in lockstep (was previously hardcoded to 3 —
    // smaller than MAX_RECENT=10 used by the store, which was inconsistent).
    for (const id of recentSymbols.slice(0, MAX_RECENT_COMMANDS)) {
      recentCmds.push({
        id: `recent-sym-${id}`,
        category: t('palette.category.recent'),
        label: id,
        icon: ArrowRightCircle,
        run: () => { setSelectedSymbol(id); setActiveTab('graph'); close(); },
      });
    }
    for (const path of recentFiles.slice(0, MAX_RECENT_COMMANDS)) {
      recentCmds.push({
        id: `recent-file-${path}`,
        category: t('palette.category.recent'),
        label: path,
        icon: ArrowRightCircle,
        run: () => { setActiveFilePath(path); setActiveTab('files'); close(); },
      });
    }
    return [...navCmds, ...vaultCmds, ...viewCmds, ...recentCmds];
  }, [
    t, mod, selected, recentSymbols, recentFiles,
    setActiveTab, setOpen, clearGraph, resetGraphFilters,
    toggleLeftPanel, toggleRightPanel, setSelectedSymbol, setActiveFilePath,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return commands;
    // In-order substring match shared with other vault search surfaces.
    return commands.filter((c) => fuzzyMatch(`${c.label} ${c.category}`, q));
  }, [commands, query]);

  // Reset cursor when the query changes — use the during-render pattern so
  // the new index is visible on the first render after the query updates.
  const [prevQuery, setPrevQuery] = useState(query);
  if (query !== prevQuery) {
    setPrevQuery(query);
    setIndex(0);
  }

  // Group by category for display, keeping original order. Using an
  // array-of-pairs collapses the previous dual-structure (ordered list +
  // map) into a single pass with one lookup per iteration.
  const groups = useMemo(() => {
    const out: { category: string; items: Command[] }[] = [];
    for (const cmd of filtered) {
      const existing = out.find((g) => g.category === cmd.category);
      if (existing) existing.items.push(cmd);
      else out.push({ category: cmd.category, items: [cmd] });
    }
    return out;
  }, [filtered]);

  // Map flat filtered index back to visual rows for keyboard nav.
  const flat = filtered;

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = flat[index];
      if (cmd) cmd.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="w-full max-w-xl p-0 border border-[var(--color-border)] bg-[var(--color-bg-elevated)]/95 backdrop-blur-xl"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">{t('palette.title')}</DialogTitle>
        <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2.5">
          <Search className="w-4 h-4 text-[var(--color-text-tertiary)]" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder={t('palette.placeholder')}
            aria-label={t('palette.title')}
            className="flex-1 bg-transparent outline-none text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-tertiary)]"
          />
        </div>
        <div className="max-h-[60vh] overflow-auto py-1" role="listbox">
          {flat.length === 0 ? (
            <div className="px-4 py-6 text-xs text-center text-[var(--color-text-tertiary)]">
              {t('palette.empty')}
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.category} className="py-1">
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)]">
                  {g.category}
                </div>
                {g.items.map((cmd) => {
                  const flatIdx = flat.indexOf(cmd);
                  const active = flatIdx === index;
                  const Icon = cmd.icon;
                  return (
                    <button
                      key={cmd.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onMouseEnter={() => setIndex(flatIdx)}
                      onClick={cmd.run}
                      className={cn(
                        'w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors',
                        active
                          ? 'bg-[var(--color-surface-hover)] text-[var(--color-text)]'
                          : 'text-[var(--color-text-secondary)]',
                      )}
                    >
                      <Icon className="w-4 h-4 flex-shrink-0 text-[var(--color-text-tertiary)]" />
                      <span className="flex-1 truncate">{cmd.label}</span>
                      {cmd.shortcut && (
                        <kbd className="ml-2 px-1.5 py-0.5 text-[10px] font-mono rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg)] text-[var(--color-text-tertiary)]">
                          {cmd.shortcut}
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default CommandPalette;
