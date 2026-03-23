import { useEffect, useCallback } from 'react'
import { X } from 'lucide-react'
import { useWorkspaceStore, type WorkspaceNotification } from '../../stores/workspace-store'

const SEVERITY_CLASSES: Record<string, string> = {
  info: 'border-accent/40 bg-accent/10',
  warning: 'border-yellow-500/40 bg-yellow-500/10',
  error: 'border-red-500/40 bg-red-500/10',
}

const AUTO_DISMISS_MS = 5000

function ToastItem({ notification }: { notification: WorkspaceNotification }) {
  const dismiss = useWorkspaceStore((s) => s.dismissNotification)
  const undoModeSwitch = useWorkspaceStore((s) => s.undoModeSwitch)

  useEffect(() => {
    const timer = setTimeout(() => dismiss(notification.id), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [notification.id, dismiss])

  const isModeSuggest = notification.title === 'Mode switched'

  return (
    <div
      className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-xs text-text shadow-lg backdrop-blur-sm animate-in slide-in-from-bottom-2 ${SEVERITY_CLASSES[notification.severity] ?? SEVERITY_CLASSES.info}`}
    >
      <div className="flex-1 min-w-0">
        <div className="font-medium">{notification.title}</div>
        <div className="text-text-secondary mt-0.5">{notification.message}</div>
        {isModeSuggest && (
          <button
            onClick={() => {
              undoModeSwitch()
              dismiss(notification.id)
            }}
            className="mt-1 text-accent text-[11px] font-medium hover:underline cursor-pointer bg-transparent border-none p-0"
          >
            Undo
          </button>
        )}
      </div>
      <button
        onClick={() => dismiss(notification.id)}
        className="shrink-0 text-text-tertiary hover:text-text cursor-pointer bg-transparent border-none p-0"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  )
}

export default function ToastContainer() {
  const notifications = useWorkspaceStore((s) => s.notifications)

  if (notifications.length === 0) return null

  // Show last 3 notifications
  const visible = notifications.slice(-3)

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80 pointer-events-auto">
      {visible.map((n) => (
        <ToastItem key={n.id} notification={n} />
      ))}
    </div>
  )
}
