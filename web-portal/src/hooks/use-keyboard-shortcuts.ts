import { useEffect } from 'react'
import type { WorkspaceMode } from '../stores/workspace-store'

const MODE_KEYS: Record<string, WorkspaceMode> = {
  '1': 'chat',
  '2': 'monitor',
  '3': 'canvas',
  '4': 'code',
}

interface ShortcutHandlers {
  setMode: (mode: WorkspaceMode) => void
  toggleSidebar: () => void
  toggleSecondary: () => void
  showShortcutsHelp: () => void
}

export function useKeyboardShortcuts({ setMode, toggleSidebar, toggleSecondary, showShortcutsHelp }: ShortcutHandlers) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) return

      // Alt+1-4 for mode switching (avoid Cmd/Ctrl+1-4 browser tab conflict)
      if (e.altKey) {
        const mode = MODE_KEYS[e.key]
        if (mode) {
          e.preventDefault()
          setMode(mode)
          return
        }
      }

      // Cmd/Ctrl+B for sidebar toggle
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        toggleSidebar()
        return
      }

      // Cmd/Ctrl+\ for secondary panel toggle
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        toggleSecondary()
        return
      }

      // Cmd/Ctrl+? for keyboard shortcuts help
      if ((e.metaKey || e.ctrlKey) && e.key === '?') {
        e.preventDefault()
        showShortcutsHelp()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setMode, toggleSidebar, toggleSecondary, showShortcutsHelp])
}
