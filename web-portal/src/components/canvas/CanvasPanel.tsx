import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { useCanvasStore, type CanvasShape, type CanvasShapeUpdate } from '../../stores/canvas-store'
import { useSessionStore } from '../../stores/session-store'
import { useTheme } from '../../hooks/useTheme'
import { customShapeUtils } from './custom-shapes'
import { CustomToolbar, CustomContextMenu, setExportJsonFn } from './canvas-overrides'
import CanvasWelcome from './canvas-welcome'
import { applyTemplate, type TemplateId } from './canvas-templates'

const TldrawEditor = lazy(() =>
  import('tldraw').then((m) => ({ default: m.Tldraw }))
)

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

const toolbarBtnCls =
  'inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-text transition-colors hover:border-white/20 hover:bg-white/[0.08]'
const toolbarCls =
  'relative overflow-hidden border-b border-white/6 bg-[#0b1018]/92 px-4 py-3 backdrop-blur-2xl'

function formatLastSync(value: number | null): string {
  if (!value) return 'Waiting for agent'
  const diff = Date.now() - value
  if (diff < 60_000) return 'Just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}

function LoadingSpinner() {
  return (
    <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-text-secondary">
      <div className="h-4 w-4 rounded-full border-2 border-accent/30 border-t-accent animate-spin" />
      Loading canvas...
    </div>
  )
}

interface PendingCanvasSyncResult {
  agentAddCount: number
  shouldMarkAgentSync: boolean
}

function updateExistingShape(editor: Editor, shapeId: string, props: Record<string, unknown>): boolean {
  const existing = editor.getShape(shapeId as TLShapeId)
  if (!existing) return false

  editor.updateShape({
    id: shapeId as TLShapeId,
    type: existing.type,
    props: { ...(existing.props as Record<string, unknown>), ...props },
  })
  return true
}

function syncPendingCanvasState(
  editor: Editor,
  pendingShapes: CanvasShape[],
  pendingUpdates: CanvasShapeUpdate[],
  pendingRemovals: string[],
): PendingCanvasSyncResult {
  if (pendingShapes.length === 0 && pendingUpdates.length === 0 && pendingRemovals.length === 0) {
    return { agentAddCount: 0, shouldMarkAgentSync: false }
  }

  const GAP = 20
  const CARD_WIDTH = 200
  const bounds = editor.getViewportPageBounds()
  const shapesToCreate = [
    ...pendingShapes.filter((shape) => Boolean(shape.type) && !editor.getShape(shape.id as TLShapeId)),
    ...pendingUpdates.filter((shape) => Boolean(shape.type) && !editor.getShape(shape.id as TLShapeId)),
  ]
  let nextX = bounds.center.x - ((Math.max(shapesToCreate.length, 1) - 1) * (CARD_WIDTH + GAP)) / 2
  const baseY = bounds.center.y - 50
  let agentAddCount = 0
  const shouldMarkAgentSync =
    pendingShapes.some((shape) => shape.source === 'agent') ||
    pendingUpdates.some((shape) => shape.source === 'agent') ||
    pendingRemovals.length > 0

  editor.run(() => {
    const removableIds = pendingRemovals.filter((shapeId) => editor.getShape(shapeId as TLShapeId))
    if (removableIds.length > 0) {
      editor.deleteShapes(removableIds as TLShapeId[])
    }

    for (const pending of pendingShapes) {
      if (updateExistingShape(editor, pending.id, pending.props)) continue
      if (!pending.type) continue

      editor.createShape({
        id: pending.id as TLShapeId,
        type: pending.type,
        x: nextX,
        y: baseY,
        props: { ...pending.props, ...(pending.source ? { source: pending.source } : {}) },
      })
      nextX += CARD_WIDTH + GAP
      if (pending.source === 'agent') {
        agentAddCount += 1
      }
    }

    for (const pending of pendingUpdates) {
      if (updateExistingShape(editor, pending.id, pending.props)) continue
      if (!pending.type) continue

      editor.createShape({
        id: pending.id as TLShapeId,
        type: pending.type,
        x: nextX,
        y: baseY,
        props: { ...pending.props, ...(pending.source ? { source: pending.source } : {}) },
      })
      nextX += CARD_WIDTH + GAP
    }
  })

  return { agentAddCount, shouldMarkAgentSync }
}

export default function CanvasPanel() {
  const pendingShapes = useCanvasStore((s) => s.pendingShapes)
  const pendingUpdates = useCanvasStore((s) => s.pendingUpdates)
  const pendingRemovals = useCanvasStore((s) => s.pendingRemovals)
  const clearPendingShapes = useCanvasStore((s) => s.clearPendingShapes)
  const clearPendingUpdates = useCanvasStore((s) => s.clearPendingUpdates)
  const clearPendingRemovals = useCanvasStore((s) => s.clearPendingRemovals)
  const isDirty = useCanvasStore((s) => s.isDirty)
  const setDirty = useCanvasStore((s) => s.setDirty)
  const sessionId = useSessionStore((s) => s.sessionId)
  const { theme } = useTheme()
  const editorRef = useRef<Editor | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectedTemplateRef = useRef<TemplateId | null>(null)
  const snapshotRef = useRef<unknown>(null)

  const [editorMode, setEditorMode] = useState<'welcome' | 'loading' | 'editor'>('welcome')
  const [agentVisualCount, setAgentVisualCount] = useState(0)
  const [lastAgentSyncAt, setLastAgentSyncAt] = useState<number | null>(null)
  const pendingMutationCount = pendingShapes.length + pendingUpdates.length + pendingRemovals.length

  const tldrawComponents = useMemo(() => ({
    Toolbar: CustomToolbar,
    ContextMenu: CustomContextMenu,
  }), [])

  // Check if session has existing shapes — if so, skip welcome
  useEffect(() => {
    if (!sessionId) return
    fetch(`/api/canvas/${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.canvas?.shapes) {
          try {
            // Skip restore if user already picked a template
            if (selectedTemplateRef.current) return
            const snapshot = JSON.parse(data.canvas.shapes)
            snapshotRef.current = snapshot
            import('tldraw/tldraw.css')
            setEditorMode('editor')
          } catch {
            /* invalid snapshot — stay on welcome */
          }
        }
      })
      .catch(() => {})
  }, [sessionId])

  useEffect(() => {
    if (editorMode !== 'welcome' || pendingShapes.length === 0) return
    import('tldraw/tldraw.css')
    setEditorMode('loading')
    requestAnimationFrame(() => setEditorMode('editor'))
  }, [editorMode, pendingShapes.length])

  const handleTemplateSelect = useCallback((id: TemplateId) => {
    selectedTemplateRef.current = id
    import('tldraw/tldraw.css')
    setEditorMode('loading')
    requestAnimationFrame(() => setEditorMode('editor'))
  }, [])

  const handleMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor
      editor.user.updateUserPreferences({ colorScheme: theme })
      editor.on('change', () => setDirty(true))

      // Restore snapshot if loading from session
      if (snapshotRef.current) {
        try {
          editor.store.loadSnapshot(snapshotRef.current as Parameters<typeof editor.store.loadSnapshot>[0])
        } catch { /* ignore */ }
        snapshotRef.current = null
      }

      // Apply template if one was selected
      if (selectedTemplateRef.current) {
        applyTemplate(editor, selectedTemplateRef.current)
        selectedTemplateRef.current = null
      }

      if (pendingMutationCount > 0) {
        const result = syncPendingCanvasState(editor, pendingShapes, pendingUpdates, pendingRemovals)
        if (result.agentAddCount > 0) {
          setAgentVisualCount((prev) => prev + result.agentAddCount)
        }
        if (result.shouldMarkAgentSync) {
          setLastAgentSyncAt(Date.now())
        }
        clearPendingShapes()
        clearPendingUpdates()
        clearPendingRemovals()
      }
    },
    [
      clearPendingRemovals,
      clearPendingShapes,
      clearPendingUpdates,
      pendingMutationCount,
      pendingRemovals,
      pendingShapes,
      pendingUpdates,
      setDirty,
      theme,
    ],
  )

  // Sync tldraw color scheme when portal theme changes
  useEffect(() => {
    editorRef.current?.user.updateUserPreferences({ colorScheme: theme })
  }, [theme])

  // Debounced auto-save
  useEffect(() => {
    if (!isDirty || !sessionId || !editorRef.current) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      const snapshot = editorRef.current?.store.getSnapshot()
      if (!snapshot) return
      try {
        await fetch(`/api/canvas/${encodeURIComponent(sessionId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shapes: JSON.stringify(snapshot), viewport: '{}' }),
        })
        setDirty(false)
      } catch { /* retry on next cycle */ }
    }, 5000)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [isDirty, sessionId, setDirty])

  // Process pending shapes from agent
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || pendingMutationCount === 0) return

    const result = syncPendingCanvasState(editor, pendingShapes, pendingUpdates, pendingRemovals)
    if (result.agentAddCount > 0) {
      setAgentVisualCount((prev) => prev + result.agentAddCount)
    }
    if (result.shouldMarkAgentSync) {
      setLastAgentSyncAt(Date.now())
    }
    clearPendingShapes()
    clearPendingUpdates()
    clearPendingRemovals()
  }, [
    clearPendingRemovals,
    clearPendingShapes,
    clearPendingUpdates,
    pendingMutationCount,
    pendingRemovals,
    pendingShapes,
    pendingUpdates,
  ])

  // Export JSON
  const exportJSON = useCallback(() => {
    if (!editorRef.current) return
    const snapshot = editorRef.current.store.getSnapshot()
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
    downloadBlob(blob, `canvas-${Date.now()}.json`)
  }, [])

  useEffect(() => {
    setExportJsonFn(exportJSON)
    return () => setExportJsonFn(() => {})
  }, [exportJSON])

  // Welcome mode — no tldraw loaded
  if (editorMode === 'welcome') {
    return (
      <div className="flex h-full w-full flex-col" data-testid="canvas-panel">
        <div className={toolbarCls} data-testid="canvas-toolbar">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_left,rgba(125,211,252,0.12),transparent_24%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0))]" />
          <div className="relative flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-text-secondary">
                  <span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_10px_rgba(0,229,255,0.55)]" />
                  Canvas
                </span>
                <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-[11px] text-text-secondary">
                  Visual workspace
                </span>
                {pendingShapes.length > 0 && (
                  <span className="rounded-full border border-accent/20 bg-accent/10 px-3 py-1 text-[11px] font-medium text-accent">
                    Agent handoff
                  </span>
                )}
              </div>
              <div className="mt-2 text-sm text-text-secondary">
                Launch a strong canvas frame, then keep applying live agent mutations into the same surface.
              </div>
            </div>
          </div>
        </div>
        <CanvasWelcome onSelect={handleTemplateSelect} pendingShapeCount={pendingShapes.length} />
      </div>
    )
  }

  // Editor mode — tldraw loaded
  return (
    <div className="flex h-full w-full flex-col" data-testid="canvas-panel">
      <div className={toolbarCls} data-testid="canvas-toolbar">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_left,rgba(125,211,252,0.12),transparent_24%),radial-gradient(circle_at_right,rgba(52,211,153,0.1),transparent_20%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0))]" />
        <div className="relative flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-text-secondary">
                <span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_10px_rgba(0,229,255,0.55)]" />
                Canvas
              </span>
              <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-[11px] text-text-secondary">
                {sessionId ? `Session ${sessionId}` : 'Ephemeral session'}
              </span>
              <span className="rounded-full border border-accent/15 bg-accent/10 px-3 py-1 text-[11px] text-accent">
                Agent visuals {agentVisualCount}
              </span>
              <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-[11px] text-text-secondary">
                Sync {formatLastSync(lastAgentSyncAt)}
              </span>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="text-lg font-semibold tracking-[-0.04em] text-white">
                Canvas studio
              </div>
              <div className="text-sm text-text-secondary">
                Spatial layer for architecture maps, review clusters, and live agent mutations.
              </div>
            </div>
          </div>

          <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-[11px] text-text-secondary md:hidden">
            View only
          </span>

          <div className="flex items-center gap-2">
            <button type="button" className={toolbarBtnCls} onClick={() => editorRef.current?.zoomToFit()} data-testid="canvas-zoom-to-fit">
              Zoom to Fit
            </button>
            <button type="button" className={toolbarBtnCls} onClick={exportJSON} data-testid="canvas-export-json">
              Export JSON
            </button>
            {isDirty ? (
              <span className="rounded-full border border-yellow-400/20 bg-yellow-400/10 px-3 py-1 text-[11px] text-yellow-300" data-testid="canvas-dirty-indicator">
                unsaved
              </span>
            ) : (
              <span className="flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-[11px] text-emerald-300" data-testid="canvas-saved-indicator">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-300" />
                saved
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="strada-canvas-stage relative flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_top_left,rgba(125,211,252,0.08),transparent_22%),radial-gradient(circle_at_82%_14%,rgba(52,211,153,0.08),transparent_20%)]" />
        <div className="pointer-events-none absolute inset-0 z-0 opacity-[0.16] [background-image:linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] [background-size:34px_34px]" />

        <div className="pointer-events-none absolute left-5 top-5 z-10 hidden max-w-[380px] rounded-[28px] border border-white/10 bg-[#0b1119]/78 p-5 shadow-[0_24px_90px_rgba(0,0,0,0.28)] backdrop-blur-2xl xl:block">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-sky-300/80">
                Studio memo
              </div>
              <div className="mt-3 text-[22px] font-semibold leading-[1.05] tracking-[-0.04em] text-white">
                Let the canvas read like an operator surface, not a debug dump.
              </div>
            </div>
            <div className="grid h-16 w-16 grid-cols-2 gap-2 rounded-[22px] border border-white/10 bg-black/20 p-2">
              <div className="rounded-lg bg-sky-300/20" />
              <div className="rounded-lg bg-white/8" />
              <div className="rounded-lg bg-white/8" />
              <div className="rounded-lg bg-emerald-300/15" />
            </div>
          </div>
          <div className="mt-4 text-sm leading-6 text-text-secondary">
            Live updates appear only when the agent emits canvas mutations. Monitor activity on its own does not repaint this board.
          </div>
          <div className="mt-4 flex flex-wrap gap-2 text-[11px] text-text-secondary">
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1">
              Applied {agentVisualCount}
            </span>
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1">
              Queue {pendingMutationCount}
            </span>
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1">
              {sessionId ? 'Persistent canvas' : 'Transient canvas'}
            </span>
          </div>
        </div>

        <div className="pointer-events-none absolute right-5 top-5 z-10 hidden w-[220px] rounded-[28px] border border-white/10 bg-[#0b1119]/74 p-4 shadow-[0_20px_80px_rgba(0,0,0,0.26)] backdrop-blur-2xl 2xl:block">
          <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-text-tertiary">
            Session state
          </div>
          <div className="mt-4 grid gap-3">
            <div className="rounded-[22px] border border-white/10 bg-white/[0.03] px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.22em] text-text-tertiary">Visuals</div>
              <div className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-white">{agentVisualCount}</div>
            </div>
            <div className="rounded-[22px] border border-white/10 bg-white/[0.03] px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.22em] text-text-tertiary">Queued</div>
              <div className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-white">{pendingMutationCount}</div>
            </div>
            <div className="rounded-[22px] border border-white/10 bg-white/[0.03] px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.22em] text-text-tertiary">Last sync</div>
              <div className="mt-2 text-sm font-medium text-text">{formatLastSync(lastAgentSyncAt)}</div>
            </div>
          </div>
        </div>

        <Suspense fallback={
          <div className="flex h-full items-center justify-center">
            <LoadingSpinner />
          </div>
        }>
          <TldrawEditor onMount={handleMount} shapeUtils={customShapeUtils} components={tldrawComponents} />
        </Suspense>
      </div>
    </div>
  )
}
