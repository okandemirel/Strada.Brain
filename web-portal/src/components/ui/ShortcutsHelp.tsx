import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './dialog'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
const mod = isMac ? '\u2318' : 'Ctrl'

interface Shortcut {
  keys: string
  descriptionKey: string
}

const SHORTCUTS: Shortcut[] = [
  { keys: 'Alt + 1', descriptionKey: 'shortcuts.switchChat' },
  { keys: 'Alt + 2', descriptionKey: 'shortcuts.switchMonitor' },
  { keys: 'Alt + 3', descriptionKey: 'shortcuts.switchCanvas' },
  { keys: 'Alt + 4', descriptionKey: 'shortcuts.switchCode' },
  { keys: `${mod} + B`, descriptionKey: 'shortcuts.toggleSidebar' },
  { keys: `${mod} + \\`, descriptionKey: 'shortcuts.toggleSecondaryPanel' },
  { keys: `${mod} + ?`, descriptionKey: 'shortcuts.showShortcuts' },
]

interface ShortcutsHelpProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function ShortcutsHelp({ open, onOpenChange }: ShortcutsHelpProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle>{t('shortcuts.title')}</DialogTitle>
        <DialogDescription>
          {t('shortcuts.description')}
        </DialogDescription>
        <div className="mt-4 grid grid-cols-[1fr_auto] gap-y-2 gap-x-6">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className="contents">
              <span className="text-sm text-text-secondary">{t(shortcut.descriptionKey)}</span>
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
