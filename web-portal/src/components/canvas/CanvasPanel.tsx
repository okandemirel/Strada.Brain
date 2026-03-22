import { useCallback, useEffect, useRef } from 'react'
import { Tldraw, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import { useCanvasStore } from '../../stores/canvas-store'
import { useSessionStore } from '../../stores/session-store'
import { customShapeUtils } from './custom-shapes'

/** Trigger a browser download from an in-memory blob. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function CanvasPanel() {
  const pendingShapes = useCanvasStore((s) => s.pendingShapes)
  const clearPendingShapes = useCanvasStore((s) => s.clearPendingShapes)
  const isDirty = useCanvasStore((s) => s.isDirty)
  const setDirty = useCanvasStore((s) => s.setDirty)
  const sessionId = useSessionStore((s) => s.sessionId)
  const editorRef = useRef<Editor | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor
      editor.on('change', () => setDirty(true))
    },
    [setDirty],
  )

  // ---------------------------------------------------------------------------
  // Load canvas state on mount (when sessionId becomes available)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!sessionId) return
    fetch(`/api/canvas/${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.canvas?.shapes && editorRef.current) {
          try {
            const snapshot = JSON.parse(data.canvas.shapes)
            editorRef.current.store.loadSnapshot(snapshot)
          } catch {
            /* ignore invalid snapshot */
          }
        }
      })
      .catch(() => {})
  }, [sessionId])

  // ---------------------------------------------------------------------------
  // Debounced auto-save: persist every 5 seconds when dirty
  // ---------------------------------------------------------------------------
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
      } catch {
        /* silent fail — next dirty cycle will retry */
      }
    }, 5000)

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [isDirty, sessionId, setDirty])

  // Process pending shapes from agent into the tldraw editor
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || pendingShapes.length === 0) return

    editor.run(() => {
      for (const pending of pendingShapes) {
        const existing = typeof (editor as any).getShape === 'function'
          ? (editor as any).getShape(pending.id)
          : undefined
        if (existing) {
          ;(editor as any).updateShape({ id: pending.id, type: pending.type, props: pending.props })
        } else {
          editor.createShape({
            id: pending.id as any,
            type: pending.type,
            props: pending.props,
          })
        }
      }
    })

    clearPendingShapes()
  }, [pendingShapes, clearPendingShapes])

  // ---------------------------------------------------------------------------
  // Export helpers
  // ---------------------------------------------------------------------------
  const exportJSON = useCallback(() => {
    if (!editorRef.current) return
    const snapshot = editorRef.current.store.getSnapshot()
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
    downloadBlob(blob, `canvas-${Date.now()}.json`)
  }, [])

  return (
    <div className="flex h-full w-full flex-col" data-testid="canvas-panel">
      <div
        className="flex items-center gap-2 border-b border-[#313244] bg-[#181825] px-3 py-1.5"
        data-testid="canvas-toolbar"
      >
        <span className="text-xs font-medium text-[#a6adc8]">Canvas</span>
        <div className="flex-1" />
        <button
          type="button"
          className="rounded bg-[#313244] px-2 py-0.5 text-xs text-[#cdd6f4] hover:bg-[#45475a]"
          onClick={exportJSON}
          data-testid="canvas-export-json"
        >
          Export JSON
        </button>
        {isDirty && (
          <span className="text-[10px] text-[#f9e2af]" data-testid="canvas-dirty-indicator">
            unsaved
          </span>
        )}
      </div>
      <div className="flex-1">
        <Tldraw onMount={handleMount} shapeUtils={customShapeUtils} />
      </div>
    </div>
  )
}
