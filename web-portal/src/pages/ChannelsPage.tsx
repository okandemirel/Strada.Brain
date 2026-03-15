import { useState, useEffect, useCallback } from 'react'
import { formatUptime } from '../utils/format'

interface HealthData {
  status: string
  channel: string
  uptime: number
  clients: number
}

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

export default function ChannelsPage() {
  const [channels, setChannels] = useState<ChannelInfo[]>([])
  const [health, setHealth] = useState<HealthData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(() => {
    Promise.all([
      fetch('/api/channels').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/health').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([channelsData, healthData]: [{ channels: ChannelInfo[] } | null, HealthData | null]) => {
      if (healthData) setHealth(healthData)

      if (channelsData?.channels) {
        setChannels(channelsData.channels)
      } else if (healthData) {
        // Synthesize from health endpoint
        setChannels([{
          name: healthData.channel || 'web',
          type: healthData.channel || 'web',
          enabled: true,
          healthy: healthData.status === 'ok',
          detail: `${healthData.clients} client${healthData.clients !== 1 ? 's' : ''} connected`,
        }])
      }
      setLoading(false)
    }).catch(e => {
      setError(e.message)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 10000)
    return () => clearInterval(interval)
  }, [fetchData])

  if (error) return <div className="page-error">Error: {error}</div>
  if (loading) return <div className="page-loading">Loading channels...</div>

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
              <span className="admin-stat-value">{formatUptime(health.uptime)}</span>
            </div>
            <div className="admin-stat-row">
              <span className="admin-stat-label">Clients</span>
              <span className="admin-stat-value">{health.clients}</span>
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
                  <span className={`status-dot-inline ${ch.enabled && ch.healthy ? 'ok' : ch.enabled ? 'warn' : 'off'}`} />
                  {ch.enabled ? (ch.healthy ? 'Active' : 'Degraded') : 'Disabled'}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
