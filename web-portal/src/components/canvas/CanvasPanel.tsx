import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { useCanvasStore } from '../../stores/canvas-store'
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

const toolbarBtnCls = 'rounded bg-white/5 px-2 py-0.5 text-xs text-text hover:bg-white/10'
const toolbarCls = 'flex items-center gap-2 border-b border-white/5 bg-white/3 backdrop-blur-xl px-3 py-1.5'

function formatLastSync(value: number | null): string {
  if (!value) return 'Waiting for agent'
  const diff = Date.now() - value
  if (diff < 60_000) return 'Just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}

function LoadingSpinner() {
  return (
    <div className="flex items-center gap-2 text-text-secondary text-sm">
      <div className="h-4 w-4 rounded-full border-2 border-accent/30 border-t-accent animate-spin" />
      Loading canvas...
    </div>
  )
}

export default function CanvasPanel() {
  const pendingShapes = useCanvasStore((s) => s.pendingShapes)
  const clearPendingShapes = useCanvasStore((s) => s.clearPendingShapes)
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

      if (pendingShapes.length > 0) {
        const GAP = 20
        const bounds = editor.getViewportPageBounds()
        let nextX = bounds.center.x - ((pendingShapes.length - 1) * (200 + GAP)) / 2
        const baseY = bounds.center.y - 50
        const agentShapes = pendingShapes.filter((shape) => shape.source === 'agent')

        editor.run(() => {
          for (const pending of pendingShapes) {
            const existing = editor.getShape(pending.id as TLShapeId)
            if (existing) {
              editor.updateShape({ id: pending.id as TLShapeId, type: pending.type, props: pending.props })
            } else {
              editor.createShape({
                id: pending.id as TLShapeId,
                type: pending.type,
                x: nextX,
                y: baseY,
                props: { ...pending.props, ...(pending.source ? { source: pending.source } : {}) },
              })
              nextX += 200 + GAP
            }
          }
        })

        if (agentShapes.length > 0) {
          setAgentVisualCount((prev) => prev + agentShapes.length)
          setLastAgentSyncAt(Date.now())
        }

        clearPendingShapes()
      }
    },
    [clearPendingShapes, pendingShapes, setDirty, theme],
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
    if (!editor || pendingShapes.length === 0) return
    const GAP = 20
    const bounds = editor.getViewportPageBounds()
    let nextX = bounds.center.x - ((pendingShapes.length - 1) * (200 + GAP)) / 2
    const baseY = bounds.center.y - 50
    const agentShapes = pendingShapes.filter((shape) => shape.source === 'agent')
    editor.run(() => {
      for (const pending of pendingShapes) {
        const existing = editor.getShape(pending.id as TLShapeId)
        if (existing) {
          editor.updateShape({ id: pending.id as TLShapeId, type: pending.type, props: pending.props })
        } else {
          editor.createShape({
            id: pending.id as TLShapeId,
            type: pending.type,
            x: nextX,
            y: baseY,
            props: { ...pending.props, ...(pending.source ? { source: pending.source } : {}) },
          })
          nextX += 200 + GAP
        }
      }
    })
    if (agentShapes.length > 0) {
      setAgentVisualCount((prev) => prev + agentShapes.length)
      setLastAgentSyncAt(Date.now())
    }
    clearPendingShapes()
  }, [pendingShapes, clearPendingShapes])

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
          <span className="text-xs font-medium text-text-secondary">Canvas</span>
          {pendingShapes.length > 0 && (
            <span className="rounded-full border border-accent/20 bg-accent/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-accent">
              Agent handoff
            </span>
          )}
        </div>
        <CanvasWelcome onSelect={handleTemplateSelect} pendingShapeCount={pendingShapes.length} />
      </div>
    )
  }

  // Editor mode — tldraw loaded
  return (
    <div className="flex h-full w-full flex-col" data-testid="canvas-panel">
      <div className={toolbarCls} data-testid="canvas-toolbar">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-medium text-text-secondary">Canvas</span>
          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-text-secondary">
            {sessionId ? `Session ${sessionId}` : 'Ephemeral session'}
          </span>
          <span className="rounded-full border border-accent/15 bg-accent/10 px-2 py-0.5 text-[10px] text-accent">
            Agent visuals {agentVisualCount}
          </span>
          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-text-secondary">
            Sync {formatLastSync(lastAgentSyncAt)}
          </span>
        </div>
        <span className="text-[10px] text-text-secondary bg-white/5 rounded px-1.5 py-0.5 md:hidden">
          View only
        </span>
        <div className="flex-1" />
        <button type="button" className={toolbarBtnCls} onClick={() => editorRef.current?.zoomToFit()} data-testid="canvas-zoom-to-fit">
          Zoom to Fit
        </button>
        <button type="button" className={toolbarBtnCls} onClick={exportJSON} data-testid="canvas-export-json">
          Export JSON
        </button>
        {isDirty ? (
          <span className="text-[10px] text-yellow-400" data-testid="canvas-dirty-indicator">unsaved</span>
        ) : (
          <span className="flex items-center gap-1 text-[10px] text-emerald-400" data-testid="canvas-saved-indicator">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
            saved
          </span>
        )}
      </div>
      <div className="relative flex-1">
        <div className="pointer-events-none absolute left-4 top-4 z-10 hidden max-w-sm rounded-2xl border border-white/8 bg-bg/80 px-4 py-3 shadow-[0_18px_60px_rgba(0,0,0,0.18)] backdrop-blur-xl md:block">
          <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-accent/80">
            Agent Canvas
          </div>
          <div className="mt-1 text-sm font-medium text-text">
            Visual outputs land here as architecture maps, diffs, and planning boards.
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-text-secondary">
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">
              Applied {agentVisualCount}
            </span>
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">
              Queue {pendingShapes.length}
            </span>
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">
              {sessionId ? 'Persistent canvas' : 'Transient canvas'}
            </span>
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
