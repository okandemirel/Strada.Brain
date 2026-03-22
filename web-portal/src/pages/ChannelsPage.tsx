import { formatUptime } from '../utils/format'
import { useChannels, useHealth } from '../hooks/use-api'

interface ChannelInfo {
  name: string
  type: string
  enabled: boolean
  healthy: boolean
  detail?: string
}

const CHANNEL_ICONS: Record<string, string> = {
  web: 'W',
  telegram: 'T',
  discord: 'D',
  slack: 'S',
  whatsapp: 'A',
  cli: '>',
}

function statusDotClass(ch: ChannelInfo): string {
  if (!ch.enabled) return 'off'
  return ch.healthy ? 'ok' : 'warn'
}

function statusLabel(ch: ChannelInfo): string {
  if (!ch.enabled) return 'Disabled'
  return ch.healthy ? 'Active' : 'Degraded'
}

export default function ChannelsPage() {
  const channelsQuery = useChannels()
  const healthQuery = useHealth()

  const loading = channelsQuery.isLoading && healthQuery.isLoading
  const error = channelsQuery.error && healthQuery.error
    ? channelsQuery.error.message
    : null
  const health = healthQuery.data ?? null

  if (error) return <div className="page-error">Error: {error}</div>
  if (loading) return <div className="page-loading">Loading channels...</div>

  // Derive channels from endpoint or synthesize from health
  let channels: ChannelInfo[] = channelsQuery.data?.channels ?? []
  if (channels.length === 0 && health) {
    const clientCount = health.clients ?? 0
    channels = [{
      name: health.channel || 'web',
      type: health.channel || 'web',
      enabled: true,
      healthy: health.status === 'ok',
      detail: `${clientCount} client${clientCount !== 1 ? 's' : ''} connected`,
    }]
  }

  return (
    <div className="admin-page">
      <h2>Channels</h2>

      {health && (
        <div className="admin-section">
          <div className="admin-section-title">Server Health</div>
          <div className="admin-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
            <div className="admin-stat-row">
              <span className="admin-stat-label">Status</span>
              <span className="admin-stat-value">
                <span className={`status-dot-inline ${health.status === 'ok' ? 'ok' : 'err'}`} />{' '}
                {health.status}
              </span>
            </div>
            <div className="admin-stat-row">
              <span className="admin-stat-label">Uptime</span>
              <span className="admin-stat-value">{formatUptime(health.uptime ?? 0)}</span>
            </div>
            <div className="admin-stat-row">
              <span className="admin-stat-label">Clients</span>
              <span className="admin-stat-value">{health.clients ?? 0}</span>
            </div>
          </div>
        </div>
      )}

      <div className="admin-section">
        <div className="admin-section-title">Active Channels</div>
        {channels.length === 0 ? (
          <div className="page-empty">
            <h3>No Channels</h3>
            <p>No channel data available. The server may not expose channel information yet.</p>
          </div>
        ) : (
          <div className="admin-grid">
            {channels.map(ch => (
              <div key={ch.name} className="channel-card">
                <div className="channel-icon">
                  {CHANNEL_ICONS[ch.type] ?? ch.type.charAt(0).toUpperCase()}
                </div>
                <div className="channel-info">
                  <div className="channel-name">{ch.name}</div>
                  {ch.detail && <div className="channel-detail">{ch.detail}</div>}
                </div>
                <div className={`channel-status ${ch.enabled && ch.healthy ? 'active' : 'inactive'}`}>
                  <span className={`status-dot-inline ${statusDotClass(ch)}`} />
                  {statusLabel(ch)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
