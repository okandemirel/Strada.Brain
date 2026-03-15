import { useState, useEffect, useCallback } from 'react'
import { formatUptime } from '../utils/format'

interface IdentityState {
  agentName: string
  version: string
  bootCount: number
  firstBoot: string
  lastBoot: string
  continuityHash: string
  mode: string
}

interface DaemonData {
  running: boolean
  identity: IdentityState | null
  triggers: Array<{
    name: string
    type: string
    state: string
    circuitState?: string
  }>
  budget: {
    usedUsd: number
    limitUsd: number
    pct: number
  }
  capabilityManifest?: Record<string, unknown> | null
}

function formatDate(ts: string): string {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ts
  }
}

export default function IdentityPage() {
  const [daemon, setDaemon] = useState<DaemonData | null>(null)
  const [uptime, setUptime] = useState<number>(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(() => {
    Promise.all([
      fetch('/api/daemon').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/metrics').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([daemonData, metricsData]: [DaemonData | null, { uptime: number } | null]) => {
      if (daemonData) setDaemon(daemonData)
      if (metricsData?.uptime) setUptime(metricsData.uptime / 1000)
      if (!daemonData && !metricsData) setError('Could not reach the server')
      setLoading(false)
    }).catch(e => {
      setError(e.message)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 15000)
    return () => clearInterval(interval)
  }, [fetchData])

  if (loading) return <div className="page-loading">Loading identity...</div>
  if (error && !daemon) return <div className="page-error">Error: {error}</div>

  const identity = daemon?.identity

  return (
    <div className="admin-page">
      <h2>Identity</h2>

      <div className="admin-section">
        <div className="admin-section-title">Agent Identity</div>
        {identity ? (
          <div className="admin-grid">
            <div className="admin-card">
              <div className="admin-card-header">
                <span className="admin-card-title">{identity.agentName}</span>
                <span className={`level-badge info`}>v{identity.version}</span>
              </div>
              <div className="admin-card-body">
                <div className="admin-card-row">
                  <span className="admin-card-label">Mode</span>
                  <span className="admin-card-value">{identity.mode}</span>
                </div>
                <div className="admin-card-row">
                  <span className="admin-card-label">Boot Count</span>
                  <span className="admin-card-value">{identity.bootCount}</span>
                </div>
                <div className="admin-card-row">
                  <span className="admin-card-label">First Boot</span>
                  <span className="admin-card-value">{formatDate(identity.firstBoot)}</span>
                </div>
                <div className="admin-card-row">
                  <span className="admin-card-label">Last Boot</span>
                  <span className="admin-card-value">{formatDate(identity.lastBoot)}</span>
                </div>
              </div>
            </div>
            <div className="admin-card">
              <div className="admin-card-header">
                <span className="admin-card-title">Continuity</span>
              </div>
              <div className="admin-card-body">
                <div className="admin-card-row">
                  <span className="admin-card-label">Hash</span>
                  <span className="admin-card-value mono">{identity.continuityHash}</span>
                </div>
                <div className="admin-card-row">
                  <span className="admin-card-label">Uptime</span>
                  <span className="admin-card-value">{formatUptime(uptime)}</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="page-empty">
            <h3>No Identity State</h3>
            <p>Identity manager is not active. The daemon may not be running.</p>
          </div>
        )}
      </div>

      {daemon && (
        <div className="admin-section">
          <div className="admin-section-title">Daemon Status</div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
            <div className="admin-stat-row" style={{ flex: 1, minWidth: '150px' }}>
              <span className="admin-stat-label">Running</span>
              <span className="admin-stat-value">
                <span className={`status-dot-inline ${daemon.running ? 'ok' : 'off'}`} />{' '}
                {daemon.running ? 'Yes' : 'No'}
              </span>
            </div>
            <div className="admin-stat-row" style={{ flex: 1, minWidth: '150px' }}>
              <span className="admin-stat-label">Budget Used</span>
              <span className="admin-stat-value">
                ${daemon.budget.usedUsd.toFixed(2)}
                {daemon.budget.limitUsd > 0 && ` / $${daemon.budget.limitUsd.toFixed(2)}`}
              </span>
            </div>
            {daemon.budget.limitUsd > 0 && (
              <div className="admin-stat-row" style={{ flex: 1, minWidth: '150px' }}>
                <span className="admin-stat-label">Budget %</span>
                <span className="admin-stat-value">{daemon.budget.pct.toFixed(1)}%</span>
              </div>
            )}
          </div>

          {daemon.budget.limitUsd > 0 && (
            <div className="admin-progress-bar" style={{ marginBottom: '20px' }}>
              <div
                className={`admin-progress-fill ${daemon.budget.pct > 90 ? 'error' : daemon.budget.pct > 70 ? 'warn' : ''}`}
                style={{ width: `${Math.min(daemon.budget.pct, 100)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {daemon?.triggers && daemon.triggers.length > 0 && (
        <div className="admin-section">
          <div className="admin-section-title">Triggers ({daemon.triggers.length})</div>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>State</th>
                <th>Circuit</th>
              </tr>
            </thead>
            <tbody>
              {daemon.triggers.map(t => (
                <tr key={t.name}>
                  <td style={{ fontFamily: '"SF Mono", Consolas, monospace', fontSize: '12px' }}>{t.name}</td>
                  <td>{t.type}</td>
                  <td>
                    <span className={`status-dot-inline ${t.state === 'running' || t.state === 'enabled' ? 'ok' : t.state === 'paused' ? 'warn' : 'off'}`} />{' '}
                    {t.state}
                  </td>
                  <td>
                    <span className={`level-badge ${t.circuitState === 'CLOSED' ? 'info' : t.circuitState === 'OPEN' ? 'error' : 'warn'}`}>
                      {t.circuitState ?? 'N/A'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
