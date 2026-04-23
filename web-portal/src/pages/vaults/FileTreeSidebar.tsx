import { useEffect, useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  ChevronDown,
  File as FileIcon,
  Folder,
  FolderOpen,
  FileText,
  FileCode2,
  Search,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import { useVaultStore } from '../../stores/vault-store';
import {
  HOVER_CARD_OPEN_DELAY_MS,
  HOVER_CARD_PREVIEW_CHARS,
} from './constants';
import { useVaultFetch } from '../../hooks/useVaultFetch';
import { VaultEmptyState } from './VaultEmptyState';

interface TreeEntry { path: string; lang: string; }

interface FolderNode {
  kind: 'folder';
  name: string;
  path: string; // folder prefix
  children: TreeNode[];
}
interface FileNode {
  kind: 'file';
  name: string;
  path: string;
  lang: string;
}
type TreeNode = FolderNode | FileNode;

function buildTree(entries: TreeEntry[]): FolderNode {
  const root: FolderNode = { kind: 'folder', name: '', path: '', children: [] };
  const folderIndex = new Map<string, FolderNode>();
  folderIndex.set('', root);

  for (const entry of entries) {
    const segments = entry.path.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    let parent = root;
    let accum = '';
    for (let i = 0; i < segments.length - 1; i++) {
      accum = accum ? `${accum}/${segments[i]}` : segments[i];
      let folder = folderIndex.get(accum);
      if (!folder) {
        folder = { kind: 'folder', name: segments[i], path: accum, children: [] };
        folderIndex.set(accum, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }
    const fileName = segments[segments.length - 1];
    parent.children.push({ kind: 'file', name: fileName, path: entry.path, lang: entry.lang });
  }

  const sortRec = (node: FolderNode) => {
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of node.children) if (c.kind === 'folder') sortRec(c);
  };
  sortRec(root);
  return root;
}

// Stable sentinel for "no entries" so `useMemo([entries])` has a steady
// reference across renders when the fetch hasn't returned yet.
const EMPTY_ENTRIES: TreeEntry[] = [];

type LangKind = 'md' | 'code' | 'other';
function fileLangKind(lang: string): LangKind {
  if (lang === 'markdown' || lang === 'md') return 'md';
  if (
    lang === 'typescript' || lang === 'javascript' ||
    lang === 'tsx' || lang === 'jsx' || lang === 'csharp'
  ) {
    return 'code';
  }
  return 'other';
}

function FileKindIcon({ kind, className }: { kind: LangKind; className?: string }) {
  if (kind === 'md') return <FileText className={className} />;
  if (kind === 'code') return <FileCode2 className={className} />;
  return <FileIcon className={className} />;
}

interface FileRowProps {
  node: FileNode;
  depth: number;
  activePath: string | null;
  vaultId: string;
  onSelect: (path: string) => void;
  onContextMenu: (evt: React.MouseEvent, path: string) => void;
}

function FileRow({ node, depth, activePath, vaultId, onSelect, onContextMenu }: FileRowProps) {
  const { t } = useTranslation('vault');
  const langKind = fileLangKind(node.lang);
  const active = activePath === node.path;

  // Lazy preview fetch: gate the request on hover-card open state so we don't
  // load every visible file up front. `useVaultFetch` handles AbortController
  // cleanup, retry counters, and error surfacing — previously done inline with
  // a bespoke 4-state machine that lacked an abort on unmount.
  const [open, setOpen] = useState(false);
  const previewUrl = `/api/vaults/${encodeURIComponent(vaultId)}/file?path=${encodeURIComponent(node.path)}`;
  const { data, loading, error, retry } = useVaultFetch<{ body?: string }>(
    previewUrl,
    { enabled: open },
  );
  const previewContent = (data?.body ?? '').slice(0, HOVER_CARD_PREVIEW_CHARS);

  return (
    <HoverCard
      openDelay={HOVER_CARD_OPEN_DELAY_MS}
      onOpenChange={(next) => { if (next) setOpen(true); }}
    >
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={() => onSelect(node.path)}
          onContextMenu={(evt) => onContextMenu(evt, node.path)}
          className={cn(
            'group w-full flex items-center gap-1.5 py-[3px] pr-2 text-[13px] text-left leading-tight',
            'hover:bg-[var(--color-surface-hover)] transition-colors rounded-sm',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]/60',
            active && 'bg-[var(--color-surface-hover)] text-[var(--color-text)]',
            !active && 'text-[var(--color-text-secondary)]',
          )}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          title={node.path}
        >
          <FileKindIcon kind={langKind} className="w-3.5 h-3.5 flex-shrink-0 opacity-70" />
          <span className="truncate">{node.name}</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="right" align="start" className="max-w-sm text-[11px]">
        <div className="font-mono text-[10px] text-[var(--color-text-tertiary)] mb-1 break-all">
          {node.path}
        </div>
        {!open || loading ? (
          <div className="text-[var(--color-text-tertiary)]">…</div>
        ) : error ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[var(--color-error)]">{t('tree.previewError')}</span>
            <button
              type="button"
              onClick={retry}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-[var(--color-border-subtle)] text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
              aria-label={t('tree.previewRetry')}
            >
              <RefreshCw className="w-3 h-3" />
              {t('tree.previewRetry')}
            </button>
          </div>
        ) : previewContent.length === 0 ? (
          <div className="text-[var(--color-text-tertiary)]">{t('tree.empty')}</div>
        ) : (
          <pre className="whitespace-pre-wrap break-words text-[11px] text-[var(--color-text-secondary)] leading-snug">
            {previewContent}
          </pre>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

interface FolderRowProps {
  node: FolderNode;
  depth: number;
  activePath: string | null;
  vaultId: string;
  onSelect: (path: string) => void;
  onContextMenu: (evt: React.MouseEvent, path: string) => void;
  search: string;
  initiallyOpen?: boolean;
}

function FolderRow({
  node, depth, activePath, vaultId, onSelect, onContextMenu, search, initiallyOpen,
}: FolderRowProps) {
  const [open, setOpen] = useState(initiallyOpen ?? depth < 1);
  // Auto-expand when a search is active. Use the during-render pattern so
  // the first render with a search query already reflects the expansion.
  const [prevSearch, setPrevSearch] = useState(search);
  if (search !== prevSearch) {
    setPrevSearch(search);
    if (search) setOpen(true);
  }

  const ChevIcon = open ? ChevronDown : ChevronRight;
  const FolderGlyph = open ? FolderOpen : Folder;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'group w-full flex items-center gap-1 py-[3px] pr-2 text-[13px] text-left leading-tight',
          'hover:bg-[var(--color-surface-hover)] transition-colors rounded-sm',
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]/60',
          'text-[var(--color-text)]',
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        aria-expanded={open}
      >
        <ChevIcon className="w-3 h-3 flex-shrink-0 text-[var(--color-text-tertiary)]" />
        <FolderGlyph className="w-3.5 h-3.5 flex-shrink-0 text-[var(--color-accent)] opacity-80" />
        <span className="truncate font-medium">{node.name}</span>
      </button>
      {open &&
        node.children.map((child) =>
          child.kind === 'folder' ? (
            <FolderRow
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              vaultId={vaultId}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              search={search}
            />
          ) : (
            <FileRow
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              vaultId={vaultId}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          ),
        )}
    </>
  );
}

function filterTree(node: FolderNode, query: string): FolderNode {
  if (!query) return node;
  const q = query.toLowerCase();
  const rec = (n: FolderNode): FolderNode | null => {
    const kept: TreeNode[] = [];
    for (const c of n.children) {
      if (c.kind === 'file') {
        if (c.path.toLowerCase().includes(q)) kept.push(c);
      } else {
        const sub = rec(c);
        if (sub && sub.children.length > 0) kept.push(sub);
      }
    }
    return { ...n, children: kept };
  };
  return rec(node) ?? node;
}

interface ContextMenuState {
  x: number;
  y: number;
  path: string;
}

/**
 * Obsidian-style file explorer with nested folders, hover previews,
 * right-click context menu, and filter box.
 */
export function FileTreeSidebar() {
  const { t } = useTranslation('vault');
  const selected = useVaultStore((s) => s.selected);
  const activePath = useVaultStore((s) => s.activeFilePath);
  const setActiveFilePath = useVaultStore((s) => s.setActiveFilePath);
  const setActiveTab = useVaultStore((s) => s.setActiveTab);
  const setGraphFileFilter = useVaultStore((s) => s.setGraphFileFilter);

  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Reset the filter when the vault changes so stale queries don't survive
  // a switch. (Data reset is now handled inside `useVaultFetch` via its
  // during-render key-change logic.)
  const [prevSelected, setPrevSelected] = useState(selected);
  if (selected !== prevSelected) {
    setPrevSelected(selected);
    setFilter('');
  }

  const treeUrl = selected ? `/api/vaults/${encodeURIComponent(selected)}/tree` : null;
  const { data: treeData, loading } = useVaultFetch<{ items?: TreeEntry[] }>(treeUrl);
  // Depend on the response identity (changes only when the fetch completes)
  // rather than the derived `entries` array, which would otherwise get a
  // fresh identity on every render and defeat the buildTree memo.
  const entries = treeData?.items ?? EMPTY_ENTRIES;

  const rawTree = useMemo(() => buildTree(entries), [entries]);
  const tree = useMemo(() => filterTree(rawTree, filter), [rawTree, filter]);

  const handleSelect = useCallback(
    (path: string) => {
      setActiveFilePath(path);
      setActiveTab('files');
    },
    [setActiveFilePath, setActiveTab],
  );

  const handleContextMenu = useCallback((evt: React.MouseEvent, path: string) => {
    evt.preventDefault();
    setMenu({ x: evt.clientX, y: evt.clientY, path });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (!menu) return;
    const onDoc = () => closeMenu();
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    document.addEventListener('click', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('click', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [menu, closeMenu]);

  const revealInGraph = (path: string) => {
    setGraphFileFilter(path);
    setActiveTab('graph');
    closeMenu();
  };
  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard?.writeText(path);
    } catch { /* ignore */ }
    closeMenu();
  };

  if (!selected) {
    return <VaultEmptyState kind="no-vault" label={t('files.selectVault')} />;
  }

  return (
    <div
      className={cn(
        'h-full flex flex-col bg-[var(--color-bg-secondary)]',
        dragOver && 'ring-1 ring-dashed ring-[var(--color-accent)]/60',
      )}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); }}
      role="region"
      aria-label={t('rail.files')}
    >
      <div className="px-2 py-2 border-b border-[var(--color-border-subtle)] flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--color-text-tertiary)]" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('filter.search.placeholder')}
            className="h-7 pl-6 text-xs bg-[var(--color-bg)] border-[var(--color-border-subtle)]"
            aria-label={t('filter.search.placeholder')}
          />
        </div>
      </div>
      <div className="flex-1 overflow-auto py-1">
        {loading ? (
          <VaultEmptyState kind="loading" variant="inline" label="…" />
        ) : entries.length === 0 ? (
          <VaultEmptyState
            kind="empty"
            label={t('tree.empty')}
            hint={t('tree.emptyHint')}
          />
        ) : tree.children.length === 0 ? (
          <VaultEmptyState kind="no-match" variant="inline" label={t('empty.noMatches')} />
        ) : (
          <ul className="px-1">
            {tree.children.map((child) =>
              child.kind === 'folder' ? (
                <FolderRow
                  key={child.path}
                  node={child}
                  depth={0}
                  activePath={activePath}
                  vaultId={selected}
                  onSelect={handleSelect}
                  onContextMenu={handleContextMenu}
                  search={filter}
                  initiallyOpen
                />
              ) : (
                <FileRow
                  key={child.path}
                  node={child}
                  depth={0}
                  activePath={activePath}
                  vaultId={selected}
                  onSelect={handleSelect}
                  onContextMenu={handleContextMenu}
                />
              ),
            )}
          </ul>
        )}
      </div>
      {menu && (
        <div
          className="fixed z-50 min-w-[180px] rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-lg py-1 text-xs"
          style={{ top: menu.y, left: menu.x }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 hover:bg-[var(--color-surface-hover)]"
            onClick={() => revealInGraph(menu.path)}
            role="menuitem"
          >
            {t('tree.reveal')}
          </button>
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 hover:bg-[var(--color-surface-hover)]"
            onClick={() => copyPath(menu.path)}
            role="menuitem"
          >
            {t('tree.copyPath')}
          </button>
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 text-[var(--color-text-tertiary)] cursor-not-allowed"
            disabled
            role="menuitem"
          >
            {t('tree.rename')}
          </button>
        </div>
      )}
    </div>
  );
}

export default FileTreeSidebar;
