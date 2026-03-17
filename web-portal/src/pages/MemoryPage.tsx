import { useState, useCallback } from 'react'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { fetchJson } from '../utils/api'

interface MemoryMetrics {
  totalEntries: number
  hasAnalysisCache: boolean
  entriesByTier?: Record<string, number>
  health?: {
    healthy?: boolean
    issues?: string[]
    indexHealth?: string
    storageUsagePercent?: number
  } | null
}

interface ConsolidationData {
  enabled: boolean
  perTier?: Record<string, { clustered: number; pending: number; total: number }>
  lifetimeSavings?: number
  totalRuns?: number
  totalCostUsd?: number
}

interface MaintenanceData {
  decay?: {
    enabled: boolean
    tiers?: Record<string, unknown>
    exemptDomains?: string[]
    totalExempt?: number
  }
  pruning?: {
    retentionDays: number
    lastPrunedCount: number
  }
}

interface TierInfo {
  name: string
  count: number
  pending: number
  clustered: number
}

export default function MemoryPage() {
  const [memoryStats, setMemoryStats] = useState<MemoryMetrics | null>(null)
  const [consolidation, setConsolidation] = useState<ConsolidationData | null>(null)
  const [maintenance, setMaintenance] = useState<MaintenanceData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(() => {
    Promise.all([
      fetchJson<{ memory: MemoryMetrics | null }>('/api/memory'),
      fetchJson<ConsolidationData>('/api/consolidation'),
      fetchJson<MaintenanceData>('/api/maintenance'),
    ]).then(([metricsData, consData, maintData]: [
      { memory: MemoryMetrics | null } | null,
      ConsolidationData | null,
      MaintenanceData | null,
    ]) => {
      if (metricsData?.memory) setMemoryStats(metricsData.memory)
      if (consData) setConsolidation(consData)
      if (maintData) setMaintenance(maintData)
      if (metricsData || consData || maintData) {
        setError(null)
      }
      if (!metricsData && !consData && !maintData) {
        setError('Could not reach memory endpoints')
      }
      setLoading(false)
    }).catch(e => {
      setError(e.message)
      setLoading(false)
    })
  }, [])

  useAutoRefresh(fetchData, { intervalMs: 15000 })

  if (loading) return <div className="page-loading">Loading memory data...</div>
  if (error && !memoryStats && !consolidation) return <div className="page-error">Error: {error}</div>

  // Build tier list from consolidation data
  const tiers: TierInfo[] = []
  if (consolidation?.perTier) {
    for (const [name, data] of Object.entries(consolidation.perTier)) {
      tiers.push({
        name,
        count: data.total,
        pending: data.pending,
        clustered: data.clustered,
      })
    }
  } else if (memoryStats?.entriesByTier) {
    for (const [name, count] of Object.entries(memoryStats.entriesByTier)) {
      tiers.push({
        name,
        count,
        pending: 0,
        clustered: 0,
      })
    }
  }

  const totalEntries = memoryStats?.totalEntries ?? tiers.reduce((a, t) => a + t.count, 0)
  const maxTierCount = Math.max(1, ...tiers.map(t => t.count))

  return (
    <div className="admin-page">
      <h2>Memory</h2>

      {/* Overview Stats */}
      <div className="admin-section">
        <div className="admin-section-title">Overview</div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '20px' }}>
          <div className="admin-stat-row" style={{ flex: 1, minWidth: '150px' }}>
            <span className="admin-stat-label">Total Entries</span>
            <span className="admin-stat-value">{totalEntries.toLocaleString()}</span>
          </div>
          {memoryStats && (
            <div className="admin-stat-row" style={{ flex: 1, minWidth: '150px' }}>
              <span className="admin-stat-label">Analysis Cache</span>
              <span className="admin-stat-value">
                <span className={`status-dot-inline ${memoryStats.hasAnalysisCache ? 'ok' : 'off'}`} />{' '}
                {memoryStats.hasAnalysisCache ? 'Active' : 'Inactive'}
              </span>
            </div>
          )}
          {consolidation?.enabled !== undefined && (
            <div className="admin-stat-row" style={{ flex: 1, minWidth: '150px' }}>
              <span className="admin-stat-label">Consolidation</span>
              <span className="admin-stat-value">
                <span className={`status-dot-inline ${consolidation.enabled ? 'ok' : 'off'}`} />{' '}
                {consolidation.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
          )}
          {memoryStats?.health && (
            <div className="admin-stat-row" style={{ flex: 1, minWidth: '150px' }}>
              <span className="admin-stat-label">Memory Health</span>
              <span className="admin-stat-value">
                <span className={`status-dot-inline ${memoryStats.health.healthy ? 'ok' : 'warn'}`} />{' '}
                {memoryStats.health.indexHealth ?? (memoryStats.health.healthy ? 'Healthy' : 'Degraded')}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Tier Distribution */}
      {tiers.length > 0 && (
        <div className="admin-section">
          <div className="admin-section-title">Tier Distribution</div>
          {tiers.map(tier => (
            <div key={tier.name} className="memory-tier">
              <span className="memory-tier-name">{tier.name}</span>
              <div className="memory-tier-bar">
                <div className="admin-progress-bar">
                  <div
                    className="admin-progress-fill"
                    style={{ width: `${(tier.count / maxTierCount) * 100}%` }}
                  />
                </div>
                <div style={{ display: 'flex', gap: '12px', marginTop: '4px', fontSize: '11px', color: 'var(--text-tertiary)' }}>
                  <span>{tier.clustered} clustered</span>
                  <span>{tier.pending} pending</span>
                </div>
              </div>
              <span className="memory-tier-count">{tier.count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      {memoryStats?.health && (
        <div className="admin-section">
          <div className="admin-section-title">Index Health</div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            {memoryStats.health.storageUsagePercent !== undefined && (
              <div className="admin-stat-row" style={{ flex: 1, minWidth: '150px' }}>
                <span className="admin-stat-label">Storage Usage</span>
                <span className="admin-stat-value">{memoryStats.health.storageUsagePercent}%</span>
              </div>
            )}
            <div className="admin-stat-row" style={{ flex: 1, minWidth: '150px' }}>
              <span className="admin-stat-label">Issues</span>
              <span className="admin-stat-value">{memoryStats.health.issues?.length ?? 0}</span>
            </div>
          </div>
          {memoryStats.health.issues && memoryStats.health.issues.length > 0 && (
            <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--text-secondary)' }}>
              {memoryStats.health.issues.join(' • ')}
            </div>
          )}
        </div>
      )}

      {/* Consolidation Stats */}
      {consolidation?.enabled && (
        <div className="admin-section">
          <div className="admin-section-title">Consolidation</div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            {consolidation.totalRuns !== undefined && (
              <div className="admin-stat-row" style={{ flex: 1, minWidth: '150px' }}>
                <span className="admin-stat-label">Total Runs</span>
                <span className="admin-stat-value">{consolidation.totalRuns}</span>
              </div>
            )}
            {consolidation.lifetimeSavings !== undefined && (
              <div className="admin-stat-row" style={{ flex: 1, minWidth: '150px' }}>
                <span className="admin-stat-label">Entries Saved</span>
                <span className="admin-stat-value">{consolidation.lifetimeSavings}</span>
              </div>
            )}
            {consolidation.totalCostUsd !== undefined && (
              <div className="admin-stat-row" style={{ flex: 1, minWidth: '150px' }}>
                <span className="admin-stat-label">Total Cost</span>
                <span className="admin-stat-value">${consolidation.totalCostUsd.toFixed(3)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Decay & Maintenance */}
      {maintenance?.decay?.enabled && (
        <div className="admin-section">
          <div className="admin-section-title">Memory Decay</div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <div className="admin-stat-row" style={{ flex: 1, minWidth: '150px' }}>
              <span className="admin-stat-label">Decay</span>
              <span className="admin-stat-value">
                <span className="status-dot-inline ok" /> Active
              </span>
            </div>
            {maintenance.decay.totalExempt !== undefined && (
              <div className="admin-stat-row" style={{ flex: 1, minWidth: '150px' }}>
                <span className="admin-stat-label">Exempt Domains</span>
                <span className="admin-stat-value">{maintenance.decay.totalExempt}</span>
              </div>
            )}
            {maintenance.pruning && (
              <>
                <div className="admin-stat-row" style={{ flex: 1, minWidth: '150px' }}>
                  <span className="admin-stat-label">Retention</span>
                  <span className="admin-stat-value">{maintenance.pruning.retentionDays} days</span>
                </div>
                <div className="admin-stat-row" style={{ flex: 1, minWidth: '150px' }}>
                  <span className="admin-stat-label">Last Pruned</span>
                  <span className="admin-stat-value">{maintenance.pruning.lastPrunedCount} entries</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* No data fallback */}
      {!memoryStats && tiers.length === 0 && !consolidation?.enabled && !maintenance?.decay?.enabled && (
        <div className="page-empty">
          <h3>No Memory Data</h3>
          <p>Memory statistics are not available. The memory system may not be initialized.</p>
        </div>
      )}
    </div>
  )
}
