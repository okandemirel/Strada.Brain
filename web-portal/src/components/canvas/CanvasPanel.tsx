import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import {
  clearPersistedCanvasDraft,
  persistCanvasDraft,
  readPersistedCanvasDraft,
  useCanvasStore,
  type CanvasLayout,
  type CanvasShape,
  type CanvasShapeUpdate,
  type CanvasViewport,
} from '../../stores/canvas-store'
import { useSessionStore } from '../../stores/session-store'
import { useTheme } from '../../hooks/useTheme'
import { customShapeUtils } from './custom-shapes'
import { CustomToolbar, CustomContextMenu, TOOLBAR_SHAPES, setExportJsonFn } from './canvas-overrides'
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

function formatSessionLabel(sessionId: string | null): string {
  if (!sessionId) return 'Transient session'
  if (sessionId.length <= 26) return `Session ${sessionId}`
  return `Session ${sessionId.slice(0, 8)}...${sessionId.slice(-6)}`
}

function LoadingSpinner() {
  return (
    <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-text-secondary">
      <div className="h-4 w-4 rounded-full border-2 border-accent/30 border-t-accent animate-spin" />
      Loading canvas...
    </div>
  )
}

const BOARD_ACTION_GUIDE = [
  {
    key: 'fit',
    title: 'Zoom to Fit',
    description: 'Centers the camera on the current board content.',
  },
  {
    key: 'export',
    title: 'Export JSON',
    description: 'Downloads the current snapshot so you can reuse or inspect it elsewhere.',
  },
  {
    key: 'save',
    title: 'Auto-save',
    description: 'Canvas edits save back to the current session about 5 seconds after changes stop.',
  },
] as const

interface PendingCanvasSyncResult {
  agentAddCount: number
  shouldMarkAgentSync: boolean
}

function updateExistingShape(
  editor: Editor,
  shapeId: string,
  props: Record<string, unknown>,
  position?: { x: number; y: number },
): boolean {
  const existing = editor.getShape(shapeId as TLShapeId)
  if (!existing) return false

  const update = {
    id: shapeId as TLShapeId,
    type: existing.type,
    props: { ...(existing.props as Record<string, unknown>), ...props },
  } as {
    id: TLShapeId
    type: string
    props: Record<string, unknown>
    x?: number
    y?: number
  }
  if (position) {
    update.x = position.x
    update.y = position.y
  }
  editor.updateShape(update)
  return true
}

function applyPendingCanvasView(
  editor: Editor,
  pendingViewport: CanvasViewport | null,
  pendingLayout: CanvasLayout | null,
): boolean {
  let applied = false
  const viewportEditor = editor as Editor & {
    setCamera?: (camera: { x: number; y: number; z: number }, options?: { animation?: { duration: number } }) => void
  }

  if (pendingViewport && typeof viewportEditor.setCamera === 'function') {
    viewportEditor.setCamera(
      { x: pendingViewport.x, y: pendingViewport.y, z: pendingViewport.zoom },
      { animation: { duration: 180 } },
    )
    applied = true
  }

  if (pendingLayout) {
    editor.zoomToFit({ animation: { duration: 220 } })
    applied = true
  }

  return applied
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
      if (updateExistingShape(editor, pending.id, pending.props, pending.position)) continue
      if (!pending.type) continue

      editor.createShape({
        id: pending.id as TLShapeId,
        type: pending.type,
        x: pending.position?.x ?? nextX,
        y: pending.position?.y ?? baseY,
        props: { ...pending.props, ...(pending.source ? { source: pending.source } : {}) },
      })
      nextX += CARD_WIDTH + GAP
      if (pending.source === 'agent') {
        agentAddCount += 1
      }
    }

    for (const pending of pendingUpdates) {
      if (updateExistingShape(editor, pending.id, pending.props, pending.position)) continue
      if (!pending.type) continue

      editor.createShape({
        id: pending.id as TLShapeId,
        type: pending.type,
        x: pending.position?.x ?? nextX,
        y: pending.position?.y ?? baseY,
        props: { ...pending.props, ...(pending.source ? { source: pending.source } : {}) },
      })
      nextX += CARD_WIDTH + GAP
    }
  })

  return { agentAddCount, shouldMarkAgentSync }
}

function persistCanvasSnapshot(
  sessionId: string,
  snapshot: unknown,
  keepalive = false,
): Promise<Response> {
  return fetch(`/api/canvas/${encodeURIComponent(sessionId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shapes: JSON.stringify(snapshot), viewport: '{}' }),
    ...(keepalive ? { keepalive: true } : {}),
  })
}

function clearEditorCanvas(editor: Editor): void {
  const shapeIds = [...editor.getCurrentPageShapeIds()]
  if (shapeIds.length === 0) return
  editor.deleteShapes(shapeIds)
}

function loadEditorSnapshot(editor: Editor, snapshot: unknown): void {
  clearEditorCanvas(editor)
  editor.store.loadSnapshot(snapshot as Parameters<typeof editor.store.loadSnapshot>[0])
}

export default function CanvasPanel() {
  const pendingShapes = useCanvasStore((s) => s.pendingShapes)
  const pendingUpdates = useCanvasStore((s) => s.pendingUpdates)
  const pendingRemovals = useCanvasStore((s) => s.pendingRemovals)
  const pendingViewport = useCanvasStore((s) => s.pendingViewport)
  const pendingLayout = useCanvasStore((s) => s.pendingLayout)
  const clearPendingShapes = useCanvasStore((s) => s.clearPendingShapes)
  const clearPendingUpdates = useCanvasStore((s) => s.clearPendingUpdates)
  const clearPendingRemovals = useCanvasStore((s) => s.clearPendingRemovals)
  const clearPendingViewport = useCanvasStore((s) => s.clearPendingViewport)
  const clearPendingLayout = useCanvasStore((s) => s.clearPendingLayout)
  const isDirty = useCanvasStore((s) => s.isDirty)
  const setDirty = useCanvasStore((s) => s.setDirty)
  const sessionId = useSessionStore((s) => s.sessionId)
  const profileId = useSessionStore((s) => s.profileId)
  const { theme } = useTheme()
  const editorRef = useRef<Editor | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectedTemplateRef = useRef<TemplateId | null>(null)
  const snapshotRef = useRef<unknown>(null)

  const [editorMode, setEditorMode] = useState<'welcome' | 'loading' | 'editor'>('welcome')
  const [agentVisualCount, setAgentVisualCount] = useState(0)
  const [lastAgentSyncAt, setLastAgentSyncAt] = useState<number | null>(null)
  const pendingMutationCount =
    pendingShapes.length
    + pendingUpdates.length
    + pendingRemovals.length
    + (pendingViewport ? 1 : 0)
    + (pendingLayout ? 1 : 0)
  const canvasDraftSessionId = profileId ?? sessionId

  const tldrawComponents = useMemo(() => ({
    Toolbar: CustomToolbar,
    ContextMenu: CustomContextMenu,
  }), [])

  // Check if session has existing shapes — if so, skip welcome
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    const persistedDraft = canvasDraftSessionId
      ? readPersistedCanvasDraft(canvasDraftSessionId)
      : null
    fetch(`/api/canvas/${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return
        if (selectedTemplateRef.current) return

        let remoteSnapshot: unknown = null
        let remoteUpdatedAt: number | null = null
        if (data?.canvas?.shapes) {
          try {
            remoteSnapshot = JSON.parse(data.canvas.shapes)
            remoteUpdatedAt = typeof data.canvas.updatedAt === 'number' ? data.canvas.updatedAt : null
          } catch {
            remoteSnapshot = null
            remoteUpdatedAt = null
          }
        }

        const shouldPreferDraft = Boolean(
          persistedDraft &&
          (!remoteUpdatedAt || persistedDraft.updatedAt >= remoteUpdatedAt),
        )
        const snapshotToRestore = shouldPreferDraft
          ? persistedDraft?.snapshot ?? null
          : remoteSnapshot

        if (snapshotToRestore) {
          if (editorRef.current) {
            loadEditorSnapshot(editorRef.current, snapshotToRestore)
          } else {
            snapshotRef.current = snapshotToRestore
          }
          setDirty(Boolean(shouldPreferDraft && persistedDraft?.dirty))
          import('tldraw/tldraw.css')
          setEditorMode('editor')
          if (!shouldPreferDraft && canvasDraftSessionId && persistedDraft) {
            clearPersistedCanvasDraft(canvasDraftSessionId)
          }
          return
        }

        setDirty(Boolean(persistedDraft?.dirty))
        snapshotRef.current = null
        if (editorRef.current) {
          clearEditorCanvas(editorRef.current)
        }
      })
      .catch(() => {
        if (cancelled || selectedTemplateRef.current || !persistedDraft) return
        if (editorRef.current) {
          loadEditorSnapshot(editorRef.current, persistedDraft.snapshot)
        } else {
          snapshotRef.current = persistedDraft.snapshot
        }
        setDirty(Boolean(persistedDraft.dirty))
        import('tldraw/tldraw.css')
        setEditorMode('editor')
      })
    return () => {
      cancelled = true
    }
  }, [canvasDraftSessionId, sessionId, setDirty])

  useEffect(() => {
    if (editorMode !== 'welcome' || pendingMutationCount === 0) return
    import('tldraw/tldraw.css')
    setEditorMode('loading')
    requestAnimationFrame(() => setEditorMode('editor'))
  }, [editorMode, pendingMutationCount])

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
      editor.on('change', () => {
        setDirty(true)
        if (!canvasDraftSessionId) return
        if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
        draftTimerRef.current = setTimeout(() => {
          const snapshot = editor.store.getSnapshot()
          persistCanvasDraft(canvasDraftSessionId, snapshot, { dirty: true })
        }, 250)
      })

      // Restore snapshot if loading from session
      if (snapshotRef.current) {
        try {
          loadEditorSnapshot(editor, snapshotRef.current)
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
        const appliedView = applyPendingCanvasView(editor, pendingViewport, pendingLayout)
        if (result.agentAddCount > 0) {
          setAgentVisualCount((prev) => prev + result.agentAddCount)
        }
        if (result.shouldMarkAgentSync || appliedView) {
          setLastAgentSyncAt(Date.now())
        }
        clearPendingShapes()
        clearPendingUpdates()
        clearPendingRemovals()
        clearPendingViewport()
        clearPendingLayout()
      }
    },
    [
      clearPendingRemovals,
      clearPendingShapes,
      clearPendingUpdates,
      clearPendingViewport,
      clearPendingLayout,
      pendingMutationCount,
      pendingLayout,
      pendingRemovals,
      pendingShapes,
      pendingUpdates,
      pendingViewport,
      setDirty,
      theme,
      canvasDraftSessionId,
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
        const response = await persistCanvasSnapshot(sessionId, snapshot)
        if (!response.ok) {
          return
        }
        if (canvasDraftSessionId) {
          clearPersistedCanvasDraft(canvasDraftSessionId)
        }
        setDirty(false)
      } catch { /* retry on next cycle */ }
    }, 5000)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [canvasDraftSessionId, isDirty, sessionId, setDirty])

  useEffect(() => {
    if (!sessionId) return

    const flushOnPageHide = () => {
      const snapshot = editorRef.current?.store.getSnapshot()
      if (!snapshot) return
      if (canvasDraftSessionId) {
        persistCanvasDraft(canvasDraftSessionId, snapshot, { dirty: isDirty })
      }
      void persistCanvasSnapshot(sessionId, snapshot, true).catch(() => {})
    }

    window.addEventListener('pagehide', flushOnPageHide)
    return () => {
      window.removeEventListener('pagehide', flushOnPageHide)
    }
  }, [canvasDraftSessionId, isDirty, sessionId])

  useEffect(() => {
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    }
  }, [])

  // Process pending shapes from agent
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || pendingMutationCount === 0) return

    const result = syncPendingCanvasState(editor, pendingShapes, pendingUpdates, pendingRemovals)
    const appliedView = applyPendingCanvasView(editor, pendingViewport, pendingLayout)
    if (result.agentAddCount > 0) {
      setAgentVisualCount((prev) => prev + result.agentAddCount)
    }
    if (result.shouldMarkAgentSync || appliedView) {
      setLastAgentSyncAt(Date.now())
    }
    clearPendingShapes()
    clearPendingUpdates()
    clearPendingRemovals()
    clearPendingViewport()
    clearPendingLayout()
  }, [
    clearPendingRemovals,
    clearPendingShapes,
    clearPendingUpdates,
    clearPendingViewport,
    clearPendingLayout,
    pendingMutationCount,
    pendingLayout,
    pendingRemovals,
    pendingShapes,
    pendingUpdates,
    pendingViewport,
  ])

  // Export JSON
  const exportJSON = useCallback(() => {
    if (!editorRef.current) return
    const snapshot = editorRef.current.store.getSnapshot()
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
    downloadBlob(blob, `canvas-${Date.now()}.json`)
  }, [])

  const createShapeFromDock = useCallback((type: string) => {
    const editor = editorRef.current
    if (!editor) return

    const center = editor.getViewportPageBounds().center
    editor.createShape({ type, x: center.x - 100, y: center.y - 50 })
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
                {pendingMutationCount > 0 && (
                  <span className="rounded-full border border-accent/20 bg-accent/10 px-3 py-1 text-[11px] font-medium text-accent">
                    Agent handoff
                  </span>
                )}
              </div>
              <div className="mt-2 text-sm text-text-secondary">
                Start from a template, then keep architecture, notes, and agent-created visuals on one shared board.
              </div>
            </div>
          </div>
        </div>
        <CanvasWelcome onSelect={handleTemplateSelect} pendingShapeCount={pendingMutationCount} />
      </div>
    )
  }

  // Editor mode — tldraw loaded
  return (
    <div className="flex h-full w-full flex-col" data-testid="canvas-panel">
      <div className={toolbarCls} data-testid="canvas-toolbar">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_left,rgba(125,211,252,0.12),transparent_24%),radial-gradient(circle_at_right,rgba(52,211,153,0.1),transparent_20%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0))]" />
        <div className="relative grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] xl:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-text-secondary">
                <span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_10px_rgba(0,229,255,0.55)]" />
                Canvas
              </span>
              <span
                className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-[11px] text-text-secondary"
                title={sessionId ?? 'Transient session'}
              >
                {formatSessionLabel(sessionId)}
              </span>
              <span className="rounded-full border border-accent/15 bg-accent/10 px-3 py-1 text-[11px] text-accent">
                Agent visuals {agentVisualCount}
              </span>
              <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-[11px] text-text-secondary">
                Agent sync {formatLastSync(lastAgentSyncAt)}
              </span>
              <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-[11px] text-text-secondary">
                Queue {pendingMutationCount}
              </span>
            </div>

            <div className="mt-3">
              <div className="text-lg font-semibold tracking-[-0.04em] text-white">
                Shared visual board
              </div>
              <div className="mt-2 max-w-3xl text-sm leading-6 text-text-secondary">
                Keep architecture, user flow, risks, and review notes in one place. The quick-insert dock below exposes labeled block types, while the board keeps live agent visuals in the same surface.
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-text-secondary">
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1">
                  Labeled quick insert
                </span>
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1">
                  AI badge on agent visuals
                </span>
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1">
                  Auto-save per session
                </span>
              </div>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
            <button
              type="button"
              className={`${toolbarBtnCls} min-h-[60px] flex-col items-start justify-center gap-1 rounded-[22px] px-4 py-3 text-left`}
              onClick={() => editorRef.current?.zoomToFit()}
              title="Center the camera on the current board"
              data-testid="canvas-zoom-to-fit"
            >
              <span className="text-sm text-white">Zoom to Fit</span>
              <span className="text-[11px] leading-5 text-text-secondary">Center the current board content.</span>
            </button>
            <button
              type="button"
              className={`${toolbarBtnCls} min-h-[60px] flex-col items-start justify-center gap-1 rounded-[22px] px-4 py-3 text-left`}
              onClick={exportJSON}
              title="Download the current canvas as JSON"
              data-testid="canvas-export-json"
            >
              <span className="text-sm text-white">Export JSON</span>
              <span className="text-[11px] leading-5 text-text-secondary">Download a portable canvas snapshot.</span>
            </button>
            <div className="rounded-[22px] border border-white/10 bg-black/20 px-4 py-3 text-left sm:col-span-2 xl:col-span-1">
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-text-tertiary">
                Save state
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <div className="text-xs leading-5 text-text-secondary">
                  Changes auto-save into the current session.
                </div>
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
        </div>
      </div>
      <div className="strada-canvas-stage relative flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_top_left,rgba(125,211,252,0.08),transparent_22%),radial-gradient(circle_at_82%_14%,rgba(52,211,153,0.08),transparent_20%)]" />
        <div className="pointer-events-none absolute inset-0 z-0 opacity-[0.16] [background-image:linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] [background-size:34px_34px]" />

        <div className="pointer-events-none absolute right-5 top-5 z-10 hidden w-[280px] rounded-[28px] border border-white/10 bg-[#0b1119]/78 p-4 shadow-[0_20px_80px_rgba(0,0,0,0.26)] backdrop-blur-2xl 2xl:block">
          <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-text-tertiary">
            Session pulse
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
          <div className="mt-4 space-y-2">
            {BOARD_ACTION_GUIDE.map((item) => (
              <div
                key={item.key}
                className="rounded-[20px] border border-white/10 bg-black/20 px-4 py-3"
              >
                <div className="text-sm font-semibold text-text">{item.title}</div>
                <div className="mt-1 text-xs leading-5 text-text-secondary">{item.description}</div>
              </div>
            ))}
          </div>
        </div>

        <div
          className="pointer-events-none absolute inset-x-0 bottom-5 z-10 hidden justify-center px-5 lg:flex"
          data-testid="canvas-quick-insert-dock"
        >
          <div className="pointer-events-auto flex w-full max-w-[1120px] items-stretch gap-2 rounded-[30px] border border-white/10 bg-[#0b1119]/78 p-3 shadow-[0_24px_90px_rgba(0,0,0,0.26)] backdrop-blur-2xl">
            <div className="hidden w-[220px] shrink-0 rounded-[24px] border border-white/10 bg-black/20 px-4 py-4 xl:flex xl:flex-col">
              <div className="text-[10px] font-semibold uppercase tracking-[0.26em] text-sky-300/80">
                Quick insert
              </div>
              <div className="mt-3 text-lg font-semibold tracking-[-0.04em] text-white">
                Named blocks, always visible.
              </div>
              <div className="mt-2 text-xs leading-6 text-text-secondary">
                Inspired by 21st-style floating panels: add the block you need without decoding icon-only controls.
              </div>
            </div>

            <div className="grid min-w-0 flex-1 gap-2 md:grid-cols-3 xl:grid-cols-6">
              {TOOLBAR_SHAPES.map((shape) => (
                <button
                  key={shape.type}
                  type="button"
                  onClick={() => createShapeFromDock(shape.type)}
                  data-testid={`canvas-quick-insert-${shape.type}`}
                  className="group flex min-h-[104px] flex-col items-start justify-between rounded-[24px] border border-white/10 bg-white/[0.035] px-4 py-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-sky-300/25 hover:bg-sky-300/[0.07] hover:shadow-[0_18px_48px_rgba(14,165,233,0.10)]"
                  title={shape.description}
                  aria-label={`Insert ${shape.title}`}
                >
                  <div className="grid h-11 w-11 place-items-center rounded-2xl border border-white/10 bg-black/20 text-sm font-semibold text-white">
                    {shape.label}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-text">{shape.title}</div>
                    <div className="mt-1 text-[11px] leading-5 text-text-secondary">
                      {shape.hint}
                    </div>
                  </div>
                </button>
              ))}
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
