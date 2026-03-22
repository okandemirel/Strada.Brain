import { useCallback, useEffect, useRef } from 'react'
import { Tldraw, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import { useCanvasStore } from '../../stores/canvas-store'
import { customShapeUtils } from './custom-shapes'

export default function CanvasPanel() {
  const pendingShapes = useCanvasStore((s) => s.pendingShapes)
  const clearPendingShapes = useCanvasStore((s) => s.clearPendingShapes)
  const setDirty = useCanvasStore((s) => s.setDirty)
  const editorRef = useRef<Editor | null>(null)

  const handleMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor
      editor.on('change', () => setDirty(true))
    },
    [setDirty],
  )

  // Process pending shapes from agent into the tldraw editor
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || pendingShapes.length === 0) return

    editor.run(() => {
      for (const pending of pendingShapes) {
        editor.createShape({
          type: pending.type,
          props: pending.props,
        })
      }
    })

    clearPendingShapes()
  }, [pendingShapes, clearPendingShapes])

  return (
    <div className="h-full w-full" data-testid="canvas-panel">
      <Tldraw onMount={handleMount} shapeUtils={customShapeUtils} />
    </div>
  )
}
