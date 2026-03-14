import type { ConnectionStatus } from '../types/messages'
import type { Theme } from '../hooks/useTheme'

interface HeaderProps {
  status: ConnectionStatus
  theme: Theme
  onToggleTheme: () => void
}

const STATUS_CONFIG: Record<ConnectionStatus, { className: string; label: string }> = {
  connected: { className: 'status-dot connected', label: 'Connected' },
  connecting: { className: 'status-dot', label: 'Connecting...' },
  disconnected: { className: 'status-dot', label: 'Disconnected' },
  reconnecting: { className: 'status-dot reconnecting', label: 'Reconnecting...' },
}

export default function Header({ status, theme, onToggleTheme }: HeaderProps) {
  const statusCfg = STATUS_CONFIG[status]

  return (
    <header className="header">
      <div className="header-left">
        <span className="header-logo">Strada.Brain</span>
        <div className="connection-status">
          <div className={statusCfg.className} />
          <span>{statusCfg.label}</span>
        </div>
      </div>
      <div className="header-right">
        <button className="theme-toggle" onClick={onToggleTheme} title="Toggle theme">
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </div>
    </header>
  )
}
