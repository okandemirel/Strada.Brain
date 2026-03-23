import { useWS } from '../../hooks/useWS'
import { CONNECTION_STATUS } from '../../config/connection-status'

export default function StatusBar() {
  const { status } = useWS()
  const { color, label } = CONNECTION_STATUS[status]

  return (
    <div className="flex h-6 items-center gap-2 border-t border-white/5 bg-bg-secondary/30 backdrop-blur px-4 text-xs text-text-tertiary">
      <span
        className={`h-2 w-2 rounded-full ${color} ${status === 'connected' ? 'shadow-[0_0_6px_var(--color-success)]' : ''}`}
      />
      <span>{label}</span>
    </div>
  )
}
