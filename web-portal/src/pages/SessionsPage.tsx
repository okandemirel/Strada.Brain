import { formatTimeAgo } from '../utils/format'
import { useSessions, useMetrics, useAgents } from '../hooks/use-api'
import { PageSkeleton } from '../components/ui/page-skeleton'
import { PageError } from '../components/ui/page-error'

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

  if (error) return <PageError title="Failed to Load Sessions" message={error} />
  if (loading) return <PageSkeleton />

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
    <div className="h-full overflow-y-auto p-7 w-full animate-[admin-fade-in_0.3s_ease]">
      <h2 className="text-[22px] font-bold tracking-tight mb-6 text-text">Sessions</h2>

      {metrics && (
        <div className="mb-7">
          <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">Overview</div>
          <div className="flex gap-2.5 flex-wrap mb-5">
            <div className="flex-1 min-w-[150px] flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
              <span className="text-text-secondary">Active Sessions</span>
              <span className="text-text font-semibold">{metrics.activeSessions}</span>
            </div>
            <div className="flex-1 min-w-[150px] flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
              <span className="text-text-secondary">Total Messages</span>
              <span className="text-text font-semibold">{metrics.totalMessages}</span>
            </div>
          </div>
        </div>
      )}

      <div className="mb-7">
        <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">Active Sessions ({sessions.length})</div>
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-[200px] gap-2.5 text-text-secondary text-center">
            <h3 className="text-text text-lg font-semibold">No Active Sessions</h3>
            <p className="text-sm max-w-[400px]">
              {metrics
                ? 'No session details available. Session tracking data may not be exposed.'
                : 'Cannot reach the server. Make sure it is running.'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {sessions.map(s => (
              <div key={s.id} className="flex items-center gap-3 px-4 py-3.5 bg-white/3 backdrop-blur border border-white/5 rounded-2xl transition-all duration-200 hover:bg-white/5 hover:border-border-hover">
                <span className="font-mono text-xs text-accent min-w-[120px]">{s.id.length > 16 ? s.id.slice(0, 16) + '...' : s.id}</span>
                <span className="text-xs text-text-secondary min-w-[80px]">{s.channel}</span>
                {s.agentId && (
                  <span className="text-xs text-text-tertiary">
                    Agent: {s.agentId.slice(0, 8)}
                  </span>
                )}
                {s.messageCount !== undefined && (
                  <span className="text-xs text-text-secondary">
                    {s.messageCount} msgs
                  </span>
                )}
                <span className="text-xs text-text-tertiary ml-auto">
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
