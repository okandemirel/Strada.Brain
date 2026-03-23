import { Dialog, DialogContent, DialogTitle, DialogDescription } from './dialog'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
const mod = isMac ? '\u2318' : 'Ctrl'

interface Shortcut {
  keys: string
  description: string
}

const SHORTCUTS: Shortcut[] = [
  { keys: 'Alt + 1', description: 'Switch to Chat mode' },
  { keys: 'Alt + 2', description: 'Switch to Monitor mode' },
  { keys: 'Alt + 3', description: 'Switch to Canvas mode' },
  { keys: 'Alt + 4', description: 'Switch to Code mode' },
  { keys: `${mod} + B`, description: 'Toggle sidebar' },
  { keys: `${mod} + \\`, description: 'Toggle secondary panel' },
  { keys: `${mod} + ?`, description: 'Show keyboard shortcuts' },
]

interface ShortcutsHelpProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function ShortcutsHelp({ open, onOpenChange }: ShortcutsHelpProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle>Keyboard Shortcuts</DialogTitle>
        <DialogDescription>
          Available keyboard shortcuts for the workspace.
        </DialogDescription>
        <div className="mt-4 grid grid-cols-[1fr_auto] gap-y-2 gap-x-6">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className="contents">
              <span className="text-sm text-text-secondary">{shortcut.description}</span>
              <kbd className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-xs font-mono text-text">
                {shortcut.keys}
              </kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
