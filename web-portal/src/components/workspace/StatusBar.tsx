import { useWS } from '../../hooks/useWS'
import { CONNECTION_STATUS } from '../../config/connection-status'

export default function StatusBar() {
  const { status } = useWS()
  const { color, label } = CONNECTION_STATUS[status]

  return (
    <div className="flex h-6 items-center gap-2 border-t bg-bg-secondary/50 px-4 text-xs text-text-tertiary">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      <span>{label}</span>
    </div>
  )
}
