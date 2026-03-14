import { useCallback, useState } from 'react'
import type { ConnectionStatus } from '../types/messages'

interface SidePanelProps {
  status: ConnectionStatus
  messageCount: number
  isTyping: boolean
  sessionId: string | null
}

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting...',
  disconnected: 'Disconnected',
  reconnecting: 'Reconnecting...',
}

const STATUS_COLORS: Record<ConnectionStatus, string> = {
  connected: 'var(--success)',
  connecting: 'var(--warning)',
  disconnected: 'var(--error)',
  reconnecting: 'var(--warning)',
}

export default function SidePanel({ status, messageCount, isTyping, sessionId }: SidePanelProps) {
  const [isOpen, setIsOpen] = useState(true)

  const toggle = useCallback(() => setIsOpen((prev) => !prev), [])

  return (
    <>
      <button
        className={`side-panel-toggle ${isOpen ? 'open' : ''}`}
        onClick={toggle}
        title={isOpen ? 'Close panel' : 'Open panel'}
        aria-label={isOpen ? 'Close side panel' : 'Open side panel'}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {isOpen ? (
            <polyline points="9 18 15 12 9 6" />
          ) : (
            <polyline points="15 18 9 12 15 6" />
          )}
        </svg>
      </button>
      <aside className={`side-panel ${isOpen ? 'open' : ''}`}>
        <div className="side-panel-header">
          <h3>Agent Status</h3>
        </div>

        <div className="side-panel-content">
          <section className="side-panel-section">
            <h4>Connection</h4>
            <div className="side-panel-row">
              <span className="side-panel-label">Status</span>
              <span className="side-panel-value">
                <span
                  className="side-panel-dot"
                  style={{ background: STATUS_COLORS[status] }}
                />
                {STATUS_LABELS[status]}
              </span>
            </div>
            {sessionId && (
              <div className="side-panel-row">
                <span className="side-panel-label">Session</span>
                <span className="side-panel-value side-panel-mono">
                  {sessionId.length > 12 ? `${sessionId.slice(0, 12)}...` : sessionId}
                </span>
              </div>
            )}
            <div className="side-panel-row">
              <span className="side-panel-label">Messages</span>
              <span className="side-panel-value">{messageCount}</span>
            </div>
          </section>

          <section className="side-panel-section">
            <h4>Activity</h4>
            <div className="side-panel-row">
              <span className="side-panel-label">Agent</span>
              <span className="side-panel-value">
                {isTyping ? (
                  <span className="side-panel-typing">
                    <span className="side-panel-typing-dot" />
                    <span className="side-panel-typing-dot" />
                    <span className="side-panel-typing-dot" />
                    Working...
                  </span>
                ) : (
                  <span className="side-panel-idle">Idle</span>
                )}
              </span>
            </div>
          </section>
        </div>
      </aside>
    </>
  )
}
