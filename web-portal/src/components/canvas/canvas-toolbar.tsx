import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCanvasStore } from '../../stores/canvas-store'
import { getDefaultDimensions, type LayoutMode, type ResolvedShape } from './canvas-types'

const QUICK_TYPES = [
  { type: 'note-block', icon: 'M', colorCls: 'text-amber-400' },
  { type: 'code-block', icon: '<>', colorCls: 'text-sky-400' },
  { type: 'task-card', icon: 'T', colorCls: 'text-emerald-400' },
  { type: 'diagram-node', icon: 'D', colorCls: 'text-violet-400' },
  { type: 'file-card', icon: 'F', colorCls: 'text-slate-300' },
  { type: 'terminal-block', icon: '$', colorCls: 'text-emerald-300' },
] as const

const MORE_TYPES = [
  { type: 'error-card', label: 'Error' },
  { type: 'test-result', label: 'Test Result' },
  { type: 'link-card', label: 'Link' },
  { type: 'metric-card', label: 'Metric' },
  { type: 'image-block', label: 'Image' },
  { type: 'diff-block', label: 'Diff' },
  { type: 'goal-summary', label: 'Goal' },
] as const

const btnCls =
  'flex items-center gap-1.5 rounded-lg border border-white/8 bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-medium text-slate-400 transition-all hover:border-white/15 hover:bg-white/[0.07] hover:text-slate-200'

interface CanvasToolbarProps {
  getViewportCenter: () => { x: number; y: number }
}

export default function CanvasToolbar({ getViewportCenter }: CanvasToolbarProps) {
  const { t } = useTranslation('canvas')
  const addShape = useCanvasStore((s) => s.addShape)
  const pushUndo = useCanvasStore((s) => s.pushUndo)
  const undo = useCanvasStore((s) => s.undo)
  const redo = useCanvasStore((s) => s.redo)
  const setDirty = useCanvasStore((s) => s.setDirty)
  const undoStack = useCanvasStore((s) => s.undoStack)
  const redoStack = useCanvasStore((s) => s.redoStack)
  const gridSnap = useCanvasStore((s) => s.gridSnap)
  const toggleGridSnap = useCanvasStore((s) => s.toggleGridSnap)
  const layoutMode = useCanvasStore((s) => s.layoutMode)
  const setLayoutMode = useCanvasStore((s) => s.setLayoutMode)
  const [showMore, setShowMore] = useState(false)

  const LAYOUT_OPTIONS: { mode: LayoutMode; label: string }[] = [
    { mode: 'freeform', label: t('toolbar.freeform', 'Free') },
    { mode: 'flow', label: t('toolbar.flow', 'Flow') },
    { mode: 'kanban', label: t('toolbar.kanban', 'Board') },
  ]

  const addCardAtCenter = useCallback((type: string): void => {
    const center = getViewportCenter()
    const dims = getDefaultDimensions(type)
    const shape: ResolvedShape = {
      id: `user-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      x: center.x - dims.w / 2,
      y: center.y - dims.h / 2,
      w: dims.w,
      h: dims.h,
      props: getDefaultProps(type),
      source: 'user',
    }
    pushUndo()
    addShape(shape)
    setDirty(true)
    setShowMore(false)
  }, [getViewportCenter, pushUndo, addShape, setDirty])

  return (
    <div role="toolbar" aria-label={t('toolbar.label', 'Canvas toolbar')} className="flex items-center gap-1 rounded-xl border border-white/6 bg-black/50 px-2 py-1 backdrop-blur-xl">
      {/* Quick add buttons */}
      {QUICK_TYPES.map((qt) => (
        <button
          key={qt.type}
          type="button"
          className={btnCls}
          onClick={() => addCardAtCenter(qt.type)}
          title={t(`toolbar.add${qt.type.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join('')}` as string)}
          aria-label={t(`toolbar.add${qt.type.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join('')}` as string)}
        >
          <span className={`text-xs font-bold ${qt.colorCls}`}>{qt.icon}</span>
          <span className="hidden sm:inline">{t(`toolbar.${qt.type}` as string)}</span>
        </button>
      ))}

      {/* More dropdown */}
      <div className="relative">
        <button type="button" className={btnCls} onClick={() => setShowMore(!showMore)} aria-label={t('toolbar.more', 'More card types')} aria-expanded={showMore} aria-haspopup="true">
          {t('toolbar.more')}
        </button>
        {showMore && (
          <div className="absolute left-0 top-full mt-1 z-50 min-w-[140px] rounded-lg border border-white/10 bg-[#0b1018]/95 py-1 backdrop-blur-xl shadow-xl">
            {MORE_TYPES.map((mt) => (
              <button
                key={mt.type}
                type="button"
                className="w-full px-3 py-1.5 text-left text-[11px] text-slate-400 hover:bg-white/[0.06] hover:text-white transition-colors"
                onClick={() => addCardAtCenter(mt.type)}
                aria-label={`Add ${mt.label} card`}
              >
                {mt.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mx-1 h-4 w-px bg-white/8" />

      {/* Undo / Redo */}
      <button
        type="button"
        className={`${btnCls} ${undoStack.length === 0 ? 'opacity-30 pointer-events-none' : ''}`}
        onClick={undo}
        title={t('toolbar.undo')}
        aria-label={t('toolbar.undo', 'Undo')}
        aria-disabled={undoStack.length === 0}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 10h13a4 4 0 0 1 0 8H7" /><path d="m3 10 4-4M3 10l4 4" /></svg>
      </button>
      <button
        type="button"
        className={`${btnCls} ${redoStack.length === 0 ? 'opacity-30 pointer-events-none' : ''}`}
        onClick={redo}
        title={t('toolbar.redo')}
        aria-label={t('toolbar.redo', 'Redo')}
        aria-disabled={redoStack.length === 0}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10H8a4 4 0 0 0 0 8h9" /><path d="m21 10-4-4m4 4-4 4" /></svg>
      </button>

      <div className="mx-1 h-4 w-px bg-white/8" />

      {/* Grid snap toggle */}
      <button
        type="button"
        className={`${btnCls} ${gridSnap ? 'border-sky-400/30 bg-sky-400/10 text-sky-300' : ''}`}
        onClick={toggleGridSnap}
        title={t('toolbar.gridSnap')}
        aria-label={t('toolbar.gridSnap', 'Toggle grid snap')}
        aria-pressed={gridSnap}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 3v18h18M7 3v18M11 3v18M15 3v18M19 3v18M3 7h18M3 11h18M3 15h18M3 19h18" /></svg>
      </button>

      <div className="mx-1 h-4 w-px bg-white/8" />

      {/* Layout mode selector */}
      <div className="flex items-center gap-0.5 bg-white/5 rounded-lg p-0.5">
        {LAYOUT_OPTIONS.map(({ mode, label }) => (
          <button
            key={mode}
            type="button"
            onClick={() => setLayoutMode(mode)}
            className={`px-2 py-1 text-[10px] font-medium rounded-md transition-colors
              ${layoutMode === mode ? 'bg-accent/20 text-accent' : 'text-text-tertiary hover:text-text-secondary'}`}
            aria-label={`Switch to ${label} layout`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

function getDefaultProps(type: string): Record<string, unknown> {
  switch (type) {
    case 'note-block': return { content: '', color: '#fbbf24' }
    case 'code-block': return { code: '', language: 'text', title: '' }
    case 'task-card': return { title: '', status: 'todo', priority: 'medium' }
    case 'diagram-node': return { label: '', nodeType: 'default', status: 'idle' }
    case 'file-card': return { filePath: '', language: '', lineCount: 0 }
    case 'terminal-block': return { command: '', output: '' }
    case 'error-card': return { message: '', stack: '', severity: 'error' }
    case 'test-result': return { passed: 0, failed: 0, skipped: 0, coverage: 0 }
    case 'link-card': return { url: '', title: '', description: '' }
    case 'metric-card': return { label: '', value: 0, unit: '', trend: '' }
    case 'image-block': return { src: '', alt: '' }
    case 'diff-block': return { diff: '', filePath: '' }
    case 'goal-summary': return { title: '', taskCount: 0, completedCount: 0, failedCount: 0, executingCount: 0, skippedCount: 0 }
    default: return {}
  }
}
