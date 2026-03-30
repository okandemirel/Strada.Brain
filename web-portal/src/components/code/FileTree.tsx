import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { TouchedStatus } from '../../stores/code-store'
import { ChevronRight, ChevronDown, File, FileCode, FileJson, FileText, Folder, FolderOpen, Package, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface FileEntry {
  name: string
  type: 'file' | 'directory' | 'other'
}

interface TreeNodeState {
  entries: FileEntry[]
  loading: boolean
  expanded: boolean
  error?: string
}

interface FileTreeProps {
  /** Set of file paths the agent has touched (for highlighting) */
  touchedFiles?: Map<string, TouchedStatus>
  /** Called when user clicks a file */
  onFileSelect?: (path: string) => void
  /** Base API URL (defaults to '') */
  baseUrl?: string
}

const HIGHLIGHT_CLASSES: Record<string, string> = {
  modified: 'text-yellow-400',
  new: 'text-green-400',
  deleted: 'text-red-400 line-through',
}

function FileIcon({ name, size }: { name: string; size: number }) {
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() : ''
  if (ext === 'cs') return <FileCode size={size} className="shrink-0 text-text-tertiary" />
  if (ext === 'meta') return <Settings size={size} className="shrink-0 text-text-tertiary" />
  if (ext === 'json') return <FileJson size={size} className="shrink-0 text-text-tertiary" />
  if (ext === 'md') return <FileText size={size} className="shrink-0 text-text-tertiary" />
  if (ext === 'asmdef') return <Package size={size} className="shrink-0 text-text-tertiary" />
  return <File size={size} className="shrink-0 text-text-tertiary" />
}

const ERROR_KEYS: Record<string, string> = {
  requestFailed: 'fileTree.requestFailed',
  networkError: 'fileTree.networkError',
}

function TreeNode({
  path,
  name,
  type,
  depth,
  touchedFiles,
  onFileSelect,
  baseUrl,
}: {
  path: string
  name: string
  type: 'file' | 'directory'
  depth: number
  touchedFiles: Map<string, TouchedStatus>
  onFileSelect: (path: string) => void
  baseUrl: string
}) {
  const { t } = useTranslation('code')
  const [state, setState] = useState<TreeNodeState>({
    entries: [],
    loading: false,
    expanded: false,
  })

  const toggle = useCallback(async () => {
    if (type !== 'directory') return

    if (state.expanded) {
      setState((s) => ({ ...s, expanded: false }))
      return
    }

    // Reuse cached entries if already loaded
    if (state.entries.length > 0) {
      setState((s) => ({ ...s, expanded: true }))
      return
    }

    setState((s) => ({ ...s, loading: true, error: undefined }))
    try {
      const res = await fetch(`${baseUrl}/api/workspace/files?path=${encodeURIComponent(path)}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: undefined }))
        setState((s) => ({ ...s, loading: false, error: body.error ?? 'requestFailed' }))
        return
      }
      const data = await res.json()
      setState({
        entries: (data.entries ?? []).filter((e: FileEntry) => e.type !== 'other'),
        loading: false,
        expanded: true,
      })
    } catch {
      setState((s) => ({ ...s, loading: false, error: 'networkError' }))
    }
  }, [type, path, baseUrl, state.expanded, state.entries.length])

  const highlight = touchedFiles.get(path)
  const highlightClass = highlight ? HIGHLIGHT_CLASSES[highlight] ?? '' : ''

  if (type === 'file') {
    return (
      <button
        onClick={() => onFileSelect(path)}
        className={cn(
          'flex items-center gap-1 w-full text-left px-1 py-0.5 text-xs rounded-md transition-colors',
          'hover:bg-white/5',
          highlightClass,
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        <FileIcon name={name} size={14} />
        <span className="truncate">{name}</span>
      </button>
    )
  }

  return (
    <div>
      <button
        onClick={toggle}
        className={cn(
          'flex items-center gap-1 w-full text-left px-1 py-0.5 text-xs rounded-md font-medium transition-colors',
          'hover:bg-white/5',
          highlightClass,
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {state.expanded ? (
          <ChevronDown size={14} className="shrink-0 text-text-tertiary" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-text-tertiary" />
        )}
        {state.expanded ? (
          <FolderOpen size={14} className="shrink-0 text-accent" />
        ) : (
          <Folder size={14} className="shrink-0 text-accent" />
        )}
        <span className="truncate">{name}</span>
        {state.loading && <span className="ml-1 text-text-tertiary animate-pulse">...</span>}
      </button>

      {state.error && (
        <div className="text-[10px] text-error pl-6" style={{ paddingLeft: `${(depth + 1) * 12 + 4}px` }}>
          {ERROR_KEYS[state.error] ? t(ERROR_KEYS[state.error]) : state.error}
        </div>
      )}

      {state.expanded && (
        <div className="transition-all duration-200">
          {state.entries.map((entry) => (
            <TreeNode
              key={entry.name}
              path={path ? `${path}/${entry.name}` : entry.name}
              name={entry.name}
              type={entry.type as 'file' | 'directory'}
              depth={depth + 1}
              touchedFiles={touchedFiles}
              onFileSelect={onFileSelect}
              baseUrl={baseUrl}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const EMPTY_MAP = new Map<string, TouchedStatus>()
const NOOP = () => {}

export default function FileTree({ touchedFiles, onFileSelect, baseUrl = '' }: FileTreeProps) {
  const { t } = useTranslation('code')
  const files = touchedFiles ?? EMPTY_MAP
  const handleSelect = onFileSelect ?? NOOP

  return (
    <div className="h-full overflow-y-auto bg-bg-secondary p-1">
      {files.size > 0 && (
        <>
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary px-2 py-1 font-semibold">
            {t('fileTree.changedFiles', { count: files.size })}
          </div>
          {Array.from(files.entries()).map(([filePath, status]) => (
            <button
              key={filePath}
              onClick={() => handleSelect(filePath)}
              className={cn(
                'flex items-center gap-1 w-full text-left px-3 py-0.5 text-xs rounded-md transition-colors hover:bg-white/5',
                HIGHLIGHT_CLASSES[status] ?? '',
              )}
            >
              <FileIcon name={filePath.split('/').pop() ?? ''} size={14} />
              <span className="truncate">{filePath}</span>
            </button>
          ))}
          <div className="border-b border-white/5 my-1" />
        </>
      )}
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary px-2 py-1 font-semibold">{t('fileTree.explorer')}</div>
      <TreeNode
        path="."
        name={t('fileTree.projectRoot')}
        type="directory"
        depth={0}
        touchedFiles={files}
        onFileSelect={handleSelect}
        baseUrl={baseUrl}
      />
    </div>
  )
}
