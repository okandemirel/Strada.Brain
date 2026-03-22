import { formatTimeAgo } from '../utils/format'
import { useSessions, useMetrics, useAgents } from '../hooks/use-api'

interface SessionInfo {
  id: string
  channel: string
  agentId?: string
  startedAt: number
  lastActivity: number
  messageCount?: number
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString()
}

export default function SessionsPage() {
  const sessionsQuery = useSessions()
  const metricsQuery = useMetrics()
  const agentsQuery = useAgents()

  const loading = sessionsQuery.isLoading && metricsQuery.isLoading && agentsQuery.isLoading
  const error = sessionsQuery.error && metricsQuery.error && agentsQuery.error
    ? sessionsQuery.error.message
    : null
  const metrics = metricsQuery.data ?? null

  if (error) return <div className="page-error">Error: {error}</div>
  if (loading) return <div className="page-loading">Loading sessions...</div>

  // Derive session list from endpoint or synthesize from agents
  let sessions: SessionInfo[] = sessionsQuery.data?.sessions ?? []
  if (sessions.length === 0 && agentsQuery.data?.agents) {
    sessions = agentsQuery.data.agents.map(a => ({
      id: a.key,
      channel: a.channelType,
      agentId: a.id,
      startedAt: a.createdAt,
      lastActivity: a.lastActivity,
    }))
  }

  return (
    <div className="admin-page">
      <h2>Sessions</h2>

      {metrics && (
        <div className="admin-section">
          <div className="admin-section-title">Overview</div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '20px' }}>
            <div className="admin-stat-row" style={{ flex: 1, minWidth: '150px' }}>
              <span className="admin-stat-label">Active Sessions</span>
              <span className="admin-stat-value">{metrics.activeSessions}</span>
            </div>
            <div className="admin-stat-row" style={{ flex: 1, minWidth: '150px' }}>
              <span className="admin-stat-label">Total Messages</span>
              <span className="admin-stat-value">{metrics.totalMessages}</span>
            </div>
          </div>
        </div>
      )}

      <div className="admin-section">
        <div className="admin-section-title">Active Sessions ({sessions.length})</div>
        {sessions.length === 0 ? (
          <div className="page-empty">
            <h3>No Active Sessions</h3>
            <p>
              {metrics
                ? 'No session details available. Session tracking data may not be exposed.'
                : 'Cannot reach the server. Make sure it is running.'}
            </p>
          </div>
        ) : (
          <div className="session-list">
            {sessions.map(s => (
              <div key={s.id} className="session-item">
                <span className="session-id">{s.id.length > 16 ? s.id.slice(0, 16) + '...' : s.id}</span>
                <span className="session-channel">{s.channel}</span>
                {s.agentId && (
                  <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                    Agent: {s.agentId.slice(0, 8)}
                  </span>
                )}
                {s.messageCount !== undefined && (
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    {s.messageCount} msgs
                  </span>
                )}
                <span className="session-time">
                  {s.lastActivity ? formatTimeAgo(s.lastActivity) : formatTime(s.startedAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
