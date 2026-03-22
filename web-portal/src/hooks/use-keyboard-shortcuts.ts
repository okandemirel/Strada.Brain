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
}

export function useKeyboardShortcuts({ setMode, toggleSidebar, toggleSecondary }: ShortcutHandlers) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      const mode = MODE_KEYS[e.key]
      if (mode) {
        e.preventDefault()
        setMode(mode)
        return
      }

      if (e.key === 'b') {
        e.preventDefault()
        toggleSidebar()
        return
      }

      if (e.key === '\\') {
        e.preventDefault()
        toggleSecondary()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setMode, toggleSidebar, toggleSecondary])
}
