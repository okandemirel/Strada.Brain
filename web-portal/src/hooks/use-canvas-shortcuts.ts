import { useEffect, useCallback } from 'react'
import { useCanvasStore } from '../stores/canvas-store'

export function useCanvasShortcuts() {
  const deleteSelected = useCanvasStore((s) => s.deleteSelected)
  const undo = useCanvasStore((s) => s.undo)
  const redo = useCanvasStore((s) => s.redo)
  const selectAll = useCanvasStore((s) => s.selectAll)
  const duplicateSelected = useCanvasStore((s) => s.duplicateSelected)
  const deselectAll = useCanvasStore((s) => s.deselectAll)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return

      const mod = e.metaKey || e.ctrlKey

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteSelected()
      } else if (mod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if (mod && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
        e.preventDefault()
        redo()
      } else if (mod && e.key === 'a') {
        e.preventDefault()
        selectAll()
      } else if (mod && e.key === 'd') {
        e.preventDefault()
        duplicateSelected()
      } else if (e.key === 'Escape') {
        deselectAll()
      }
    },
    [deleteSelected, undo, redo, selectAll, duplicateSelected, deselectAll],
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}
