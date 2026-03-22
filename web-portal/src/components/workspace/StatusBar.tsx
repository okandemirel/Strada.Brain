import { useWS } from '../../hooks/useWS'
import type { ConnectionStatus } from '../../types/messages'

const STATUS_CONFIG: Record<ConnectionStatus, { color: string; label: string }> = {
  connected: { color: 'bg-success', label: 'Connected' },
  connecting: { color: 'bg-warning', label: 'Connecting' },
  reconnecting: { color: 'bg-warning', label: 'Reconnecting' },
  disconnected: { color: 'bg-error', label: 'Disconnected' },
}

export default function StatusBar() {
  const { status } = useWS()
  const { color, label } = STATUS_CONFIG[status]

  return (
    <div className="flex h-6 items-center gap-2 border-t bg-bg-secondary/50 px-4 text-xs text-text-tertiary">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      <span>{label}</span>
    </div>
  )
}
