import { useDashboard } from '../hooks/useDashboard'
import MetricCard from './MetricCard'
import { formatUptime } from '../utils/format'

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** Rough cost estimate: $3/1M input, $15/1M output (GPT-4 class) */
function estimateCost(input: number, output: number): string {
  const cost = (input / 1_000_000) * 3 + (output / 1_000_000) * 15
  if (cost < 0.01) return '<$0.01'
  return `$${cost.toFixed(2)}`
}

function getStatusClass(status: string): string {
  switch (status) {
    case 'ok': return 'status-ok'
    case 'degraded': return 'status-degraded'
    default: return 'status-error'
  }
}

export default function DashboardView() {
  const { data, loading, error, dashboardEnabled, lastUpdated } = useDashboard()

  if (loading) {
    return (
      <div className="dashboard-view">
        <div className="dashboard-loading">Loading dashboard data...</div>
      </div>
    )
  }

  const health = data.health
  const metrics = data.metrics
  const hasAnyData = health || metrics

  if (!hasAnyData) {
    return (
      <div className="dashboard-view">
        <div className="dashboard-unavailable">
          <h3>Dashboard Unavailable</h3>
          <p>
            {error || 'Could not connect to the dashboard or web channel. Make sure the server is running.'}
          </p>
        </div>
      </div>
    )
  }

  // Calculate messages per minute from uptime
  const uptimeSeconds = metrics?.uptime ? metrics.uptime / 1000 : (health?.uptime ?? 0)
  const uptimeMinutes = uptimeSeconds / 60
  const messagesPerMin = metrics && uptimeMinutes > 0
    ? (metrics.totalMessages / uptimeMinutes).toFixed(1)
    : '0'

  // Top 5 tools by call count
  const toolEntries = metrics
    ? Object.entries(metrics.toolCallCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
    : []

  const maxToolCalls = toolEntries.length > 0 ? toolEntries[0][1] : 1

  // Tool error rates
  const toolErrors = metrics?.toolErrorCounts ?? {}
  const totalToolCalls = metrics
    ? Object.values(metrics.toolCallCounts).reduce((a, b) => a + b, 0)
    : 0
  const totalToolErrors = Object.values(toolErrors).reduce((a, b) => a + b, 0)
  const toolErrorRate = totalToolCalls > 0
    ? ((totalToolErrors / totalToolCalls) * 100).toFixed(1)
    : '0'

  // Triggers info
  const triggers = data.triggers ?? []
  const activeTriggers = triggers.filter((t) => t.enabled).length

  // Agents info
  const agents = data.agents
  const delegations = data.delegations

  return (
    <div className="dashboard-view">
      <div className="dashboard-header-row">
        <h2>System Dashboard</h2>
        <div className="dashboard-meta">
          {!dashboardEnabled && (
            <span className="dashboard-badge badge-warn">Dashboard API offline</span>
          )}
          {lastUpdated && (
            <span className="dashboard-last-update">
              Updated {new Date(lastUpdated).toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {/* System Health Card */}
      <section className="dashboard-section">
        <h3 className="dashboard-section-title">System Health</h3>
        <div className="metric-grid">
          <div className="metric-card health-card">
            <div className="metric-card-header">
              <span className="metric-card-title">Status</span>
            </div>
            <div className="metric-value">
              <span className={`status-badge ${getStatusClass(health?.status ?? 'unknown')}`}>
                {health?.status ?? 'unknown'}
              </span>
            </div>
          </div>
          <MetricCard
            title="Uptime"
            value={formatUptime(uptimeSeconds)}
            icon="T"
          />
          <MetricCard
            title="Connected Clients"
            value={health?.clients ?? 0}
            icon="C"
          />
          <MetricCard
            title="Active Sessions"
            value={metrics?.activeSessions ?? 0}
            icon="S"
          />
        </div>
      </section>

      {/* Metrics Cards */}
      {metrics && (
        <section className="dashboard-section">
          <h3 className="dashboard-section-title">Metrics</h3>
          <div className="metric-grid">
            <MetricCard
              title="Messages"
              value={formatNumber(metrics.totalMessages)}
              subtitle={`${messagesPerMin} msg/min`}
            />
            <MetricCard
              title="Input Tokens"
              value={formatNumber(metrics.totalTokens.input)}
            />
            <MetricCard
              title="Output Tokens"
              value={formatNumber(metrics.totalTokens.output)}
            />
            <MetricCard
              title="Est. Cost"
              value={estimateCost(metrics.totalTokens.input, metrics.totalTokens.output)}
              subtitle={`${formatNumber(metrics.totalTokens.input + metrics.totalTokens.output)} total tokens`}
            />
          </div>
        </section>
      )}

      {/* Tool Usage */}
      {toolEntries.length > 0 && (
        <section className="dashboard-section">
          <h3 className="dashboard-section-title">
            Tool Usage
            {totalToolErrors > 0 && (
              <span className="section-badge badge-error">{toolErrorRate}% error rate</span>
            )}
          </h3>
          <div className="tool-usage-list">
            {toolEntries.map(([name, count]) => (
              <div key={name} className="tool-usage-item">
                <div className="tool-usage-info">
                  <span className="tool-usage-name">{name}</span>
                  <span className="tool-usage-count">
                    {count}
                    {toolErrors[name] ? ` (${toolErrors[name]} err)` : ''}
                  </span>
                </div>
                <div className="tool-usage-bar-bg">
                  <div
                    className="tool-usage-bar"
                    style={{ width: `${(count / maxToolCalls) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Agent Metrics */}
      {metrics && (
        <section className="dashboard-section">
          <h3 className="dashboard-section-title">Agent Performance</h3>
          <div className="metric-grid">
            <MetricCard
              title="Total Tool Calls"
              value={formatNumber(totalToolCalls)}
            />
            <MetricCard
              title="Tool Error Rate"
              value={`${toolErrorRate}%`}
              trend={totalToolErrors > 0 ? 'down' : 'neutral'}
            />
            <MetricCard
              title="Provider"
              value={metrics.providerName}
            />
            {metrics.memoryStats && (
              <MetricCard
                title="Memory Entries"
                value={formatNumber(metrics.memoryStats.totalEntries)}
              />
            )}
          </div>
        </section>
      )}

      {/* Daemon Status */}
      {triggers.length > 0 && (
        <section className="dashboard-section">
          <h3 className="dashboard-section-title">Daemon Triggers</h3>
          <div className="metric-grid">
            <MetricCard
              title="Active Triggers"
              value={activeTriggers}
              subtitle={`${triggers.length} total`}
            />
          </div>
          <div className="trigger-list">
            {triggers.map((t) => (
              <div key={t.id} className="trigger-item">
                <span className={`trigger-status-dot ${t.enabled ? 'active' : ''}`} />
                <span className="trigger-name">{t.id}</span>
                <span className="trigger-type">{t.type}</span>
                <span className="trigger-fires">{t.fireCount} fires</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Multi-Agent */}
      {agents?.enabled && (
        <section className="dashboard-section">
          <h3 className="dashboard-section-title">Multi-Agent</h3>
          <div className="metric-grid">
            <MetricCard
              title="Active Agents"
              value={agents.activeCount ?? 0}
              subtitle={`${agents.agents?.length ?? 0} total`}
            />
            {agents.globalBudget && (
              <MetricCard
                title="Budget Used"
                value={`$${agents.globalBudget.usedUsd.toFixed(2)}`}
                subtitle={`${agents.globalBudget.pct.toFixed(0)}% of limit`}
              />
            )}
          </div>
        </section>
      )}

      {/* Delegations */}
      {delegations?.enabled && (
        <section className="dashboard-section">
          <h3 className="dashboard-section-title">Delegations</h3>
          <div className="metric-grid">
            <MetricCard
              title="Active"
              value={delegations.active?.length ?? 0}
            />
            {delegations.stats?.map((s) => (
              <MetricCard
                key={s.type}
                title={s.type}
                value={s.count}
                subtitle={`${(s.successRate * 100).toFixed(0)}% success`}
              />
            ))}
          </div>
        </section>
      )}

      {/* Consolidation */}
      {data.consolidation?.enabled && (
        <section className="dashboard-section">
          <h3 className="dashboard-section-title">Memory Consolidation</h3>
          <div className="metric-grid">
            <MetricCard
              title="Total Runs"
              value={data.consolidation.totalRuns ?? 0}
            />
            <MetricCard
              title="Lifetime Savings"
              value={`${data.consolidation.lifetimeSavings ?? 0} entries`}
            />
            {data.consolidation.totalCostUsd !== undefined && (
              <MetricCard
                title="Consolidation Cost"
                value={`$${data.consolidation.totalCostUsd.toFixed(3)}`}
              />
            )}
          </div>
        </section>
      )}

      {/* Deployment */}
      {data.deployment?.enabled && data.deployment.stats && (
        <section className="dashboard-section">
          <h3 className="dashboard-section-title">Deployments</h3>
          <div className="metric-grid">
            <MetricCard
              title="Total"
              value={data.deployment.stats.totalDeployments}
            />
            <MetricCard
              title="Successful"
              value={data.deployment.stats.successful}
            />
            <MetricCard
              title="Failed"
              value={data.deployment.stats.failed}
              trend={data.deployment.stats.failed > 0 ? 'down' : 'neutral'}
            />
            <MetricCard
              title="Circuit Breaker"
              value={data.deployment.stats.circuitBreakerState}
            />
          </div>
        </section>
      )}

      {/* Maintenance */}
      {data.maintenance?.decay?.enabled && (
        <section className="dashboard-section">
          <h3 className="dashboard-section-title">Maintenance</h3>
          <div className="metric-grid">
            <MetricCard
              title="Memory Decay"
              value={data.maintenance.decay.enabled ? 'Active' : 'Disabled'}
            />
            <MetricCard
              title="Exempt Domains"
              value={data.maintenance.decay.totalExempt ?? 0}
            />
            {data.maintenance.pruning && (
              <MetricCard
                title="Trigger Pruning"
                value={`${data.maintenance.pruning.retentionDays}d retention`}
                subtitle={`${data.maintenance.pruning.lastPrunedCount} last pruned`}
              />
            )}
          </div>
        </section>
      )}

      {/* Security */}
      {metrics?.securityStats && (metrics.securityStats.secretsSanitized > 0 || metrics.securityStats.toolsBlocked > 0) && (
        <section className="dashboard-section">
          <h3 className="dashboard-section-title">Security</h3>
          <div className="metric-grid">
            <MetricCard
              title="Secrets Sanitized"
              value={metrics.securityStats.secretsSanitized}
            />
            <MetricCard
              title="Tools Blocked"
              value={metrics.securityStats.toolsBlocked}
              subtitle={metrics.readOnlyMode ? 'Read-only mode' : ''}
            />
          </div>
        </section>
      )}
    </div>
  )
}
