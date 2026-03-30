import { useTranslation } from 'react-i18next'
import { useHealth, useMetrics, useTriggers, useAgents, useDelegations, useConsolidation, useDeployment, useMaintenance } from '../hooks/use-api'
import MetricCard from './MetricCard'
import { PageSkeleton } from './ui/page-skeleton'
import { Sparkline } from './ui/sparkline'
import { formatUptime } from '../utils/format'

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function estimateCost(input: number, output: number): string {
  const cost = (input / 1_000_000) * 3 + (output / 1_000_000) * 15
  if (cost < 0.01) return '<$0.01'
  return `$${cost.toFixed(2)}`
}

function getStatusClass(status: string): string {
  switch (status) {
    case 'ok': return 'bg-success/10 text-success'
    case 'degraded': return 'bg-warning/10 text-warning'
    default: return 'bg-error/10 text-error'
  }
}


export default function DashboardView() {
  const { t } = useTranslation()
  const healthQuery = useHealth()
  const metricsQuery = useMetrics()
  const triggersQuery = useTriggers()
  const agentsQuery = useAgents()
  const delegationsQuery = useDelegations()
  const consolidationQuery = useConsolidation()
  const deploymentQuery = useDeployment()
  const maintenanceQuery = useMaintenance()

  const loading = healthQuery.isLoading && metricsQuery.isLoading
  const health = healthQuery.data ?? null
  const metrics = metricsQuery.data ?? null
  const triggers = triggersQuery.data ?? []
  const agents = agentsQuery.data ?? null
  const delegations = delegationsQuery.data ?? null
  const consolidation = consolidationQuery.data ?? null
  const deployment = deploymentQuery.data ?? null
  const maintenance = maintenanceQuery.data ?? null

  const dashboardEnabled = metricsQuery.isSuccess
  const error = !dashboardEnabled && !health
    ? (metricsQuery.error?.message ?? healthQuery.error?.message ?? t('dashboard.notEnabledUnreachable'))
    : null
  const lastUpdated = metricsQuery.dataUpdatedAt || healthQuery.dataUpdatedAt || null

  if (loading) {
    return <PageSkeleton rows={8} grid />
  }

  const hasAnyData = health || metrics

  if (!hasAnyData) {
    return (
      <div className="h-full overflow-y-auto p-7 w-full">
        <div className="flex flex-col items-center justify-center h-[200px] gap-2.5 text-text-secondary text-center">
          <h3 className="text-text text-lg font-semibold">{t('dashboard.unavailable')}</h3>
          <p className="text-sm max-w-[400px]">
            {error || t('dashboard.unavailableMessage')}
          </p>
        </div>
      </div>
    )
  }

  const uptimeSeconds = metrics?.uptime ? metrics.uptime / 1000 : (health?.uptime ?? 0)
  const uptimeMinutes = uptimeSeconds / 60
  const messagesPerMin = metrics && uptimeMinutes > 0
    ? (metrics.totalMessages / uptimeMinutes).toFixed(1)
    : '0'

  const toolEntries = metrics
    ? Object.entries(metrics.toolCallCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
    : []

  const maxToolCalls = toolEntries.length > 0 ? toolEntries[0][1] : 1

  const toolErrors = metrics?.toolErrorCounts ?? {}
  const totalToolCalls = metrics
    ? Object.values(metrics.toolCallCounts).reduce((a, b) => a + b, 0)
    : 0
  const totalToolErrors = Object.values(toolErrors).reduce((a, b) => a + b, 0)
  const toolErrorRate = totalToolCalls > 0
    ? ((totalToolErrors / totalToolCalls) * 100).toFixed(1)
    : '0'

  const activeTriggers = triggers.filter((t) => t.enabled).length

  return (
    <div className="h-full overflow-y-auto p-7 w-full">
      <div className="flex items-center justify-between mb-7">
        <h2 className="text-[22px] font-bold tracking-tight">{t('dashboard.title')}</h2>
        <div className="flex items-center gap-3">
          {!dashboardEnabled && (
            <span className="text-[11px] font-semibold px-2.5 py-1 rounded-lg bg-warning/10 text-warning">{t('dashboard.apiOffline')}</span>
          )}
          {lastUpdated && (
            <span className="text-xs text-text-tertiary">
              {t('dashboard.updated', { time: new Date(lastUpdated).toLocaleTimeString() })}
            </span>
          )}
        </div>
      </div>

      {/* System Health */}
      <section className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-6">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary mb-3">{t('dashboard.health.title')}</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-white/3 backdrop-blur-xl border border-white/8 border-l-[3px] border-l-accent rounded-2xl p-4 flex flex-col gap-2 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_0_20px_rgba(0,229,255,0.15)]">
            <span className="text-xs text-text-secondary font-medium uppercase tracking-wide">{t('dashboard.health.status')}</span>
            <div className="text-lg font-bold text-text flex items-baseline gap-1.5">
              <span className={`inline-block text-[13px] font-semibold px-3.5 py-[5px] rounded-lg uppercase tracking-[0.03em] ${getStatusClass(health?.status ?? 'unknown')}`}>
                {health?.status ?? 'unknown'}
              </span>
            </div>
          </div>
          <MetricCard title={t('dashboard.health.uptime')} value={formatUptime(uptimeSeconds)} icon="T" />
          <MetricCard title={t('dashboard.health.connectedClients')} value={health?.clients ?? 0} icon="C" />
          <MetricCard title={t('dashboard.health.activeSessions')} value={metrics?.activeSessions ?? 0} icon="S" />
        </div>
      </section>

      {/* Metrics */}
      {metrics && (
        <section className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary mb-3">{t('dashboard.metrics.title')}</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard title={t('dashboard.metrics.messages')} value={formatNumber(metrics.totalMessages)} subtitle={t('dashboard.metrics.msgPerMin', { rate: messagesPerMin })} />
            <MetricCard title={t('dashboard.metrics.inputTokens')} value={formatNumber(metrics.totalTokens.input)} />
            <MetricCard title={t('dashboard.metrics.outputTokens')} value={formatNumber(metrics.totalTokens.output)} />
            <MetricCard title={t('dashboard.metrics.estCost')} value={estimateCost(metrics.totalTokens.input, metrics.totalTokens.output)} subtitle={t('dashboard.metrics.totalTokens', { count: formatNumber(metrics.totalTokens.input + metrics.totalTokens.output) })} />
          </div>
          {metrics.recentTokenUsage && metrics.recentTokenUsage.length >= 2 && (
            <div className="mt-3 flex items-center gap-2 text-xs text-text-secondary">
              <span className="uppercase tracking-wide font-medium">{t('dashboard.metrics.tokenTrend')}</span>
              <Sparkline data={metrics.recentTokenUsage.map((r) => r.input + r.output)} />
            </div>
          )}
        </section>
      )}

      {/* Tool Usage */}
      {toolEntries.length > 0 && (
        <section className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary mb-3 flex items-center gap-2">
            {t('dashboard.tools.title')}
            {totalToolErrors > 0 && (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-error/10 text-error normal-case tracking-normal">{t('dashboard.tools.errorRate', { rate: toolErrorRate })}</span>
            )}
          </h3>
          <div className="flex flex-col gap-2.5 mt-2.5">
            {toolEntries.map(([name, count]) => (
              <div key={name} className="flex flex-col gap-1.5">
                <div className="flex justify-between items-center">
                  <span className="text-[13px] text-text font-mono">{name}</span>
                  <span className="text-xs text-text-tertiary">
                    {count}
                    {toolErrors[name] ? ` (${toolErrors[name]} err)` : ''}
                  </span>
                </div>
                <div className="h-1.5 bg-bg-tertiary rounded-sm overflow-hidden">
                  <div
                    className="h-full bg-accent rounded-sm transition-[width] duration-400 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] min-w-1"
                    style={{ width: `${(count / maxToolCalls) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Agent Performance */}
      {metrics && (
        <section className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary mb-3">{t('dashboard.agent.title')}</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard title={t('dashboard.agent.totalToolCalls')} value={formatNumber(totalToolCalls)} />
            <MetricCard title={t('dashboard.agent.toolErrorRate')} value={`${toolErrorRate}%`} trend={totalToolErrors > 0 ? 'down' : 'neutral'} status={totalToolErrors > 0 ? 'error' : 'default'} />
            <MetricCard title={t('dashboard.agent.provider')} value={metrics.providerName} />
            {metrics.memoryStats && <MetricCard title={t('dashboard.agent.memoryEntries')} value={formatNumber(metrics.memoryStats.totalEntries)} />}
          </div>
        </section>
      )}

      {/* Daemon Triggers */}
      {triggers.length > 0 && (
        <section className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary mb-3">{t('dashboard.triggers.title')}</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard title={t('dashboard.triggers.active')} value={activeTriggers} subtitle={t('dashboard.triggers.totalSuffix', { count: triggers.length })} status={activeTriggers > 0 ? 'success' : 'default'} />
          </div>
          <div className="mt-3.5 flex flex-col gap-1.5">
            {triggers.map((tr) => (
              <div key={tr.id} className="flex items-center gap-2.5 px-3.5 py-2.5 bg-bg-tertiary border border-border rounded-xl text-[13px] transition-all duration-200 hover:bg-bg-elevated">
                <span className={`w-2 h-2 rounded-full shrink-0 ${tr.enabled ? 'bg-success shadow-[0_0_6px_var(--color-success)]' : 'bg-text-tertiary'}`} />
                <span className="text-text font-mono text-xs flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{tr.id}</span>
                <span className="text-[11px] text-accent font-semibold uppercase">{tr.type}</span>
                <span className="text-xs text-text-tertiary whitespace-nowrap">{t('dashboard.triggers.fires', { count: tr.fireCount })}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Multi-Agent */}
      {agents?.enabled && (
        <section className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary mb-3">{t('dashboard.multiAgent.title')}</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard title={t('dashboard.multiAgent.activeAgents')} value={agents.activeCount ?? 0} subtitle={t('dashboard.triggers.totalSuffix', { count: agents.agents?.length ?? 0 })} status={(agents.activeCount ?? 0) > 0 ? 'success' : 'default'} />
            {agents.globalBudget && <MetricCard title={t('dashboard.multiAgent.budgetUsed')} value={`$${agents.globalBudget.usedUsd.toFixed(2)}`} subtitle={t('dashboard.multiAgent.budgetPercent', { percent: (agents.globalBudget.pct * 100).toFixed(0) })} status={agents.globalBudget.pct > 0.8 ? 'warning' : 'default'} />}
          </div>
        </section>
      )}

      {/* Delegations */}
      {delegations?.enabled && (
        <section className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary mb-3">{t('dashboard.delegations.title')}</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard title={t('dashboard.delegations.active')} value={delegations.active?.length ?? 0} />
            {delegations.stats?.map((s) => (
              <MetricCard key={s.type} title={s.type} value={s.count} subtitle={t('dashboard.delegations.successRate', { rate: (s.successRate * 100).toFixed(0) })} status={s.successRate < 0.5 ? 'warning' : 'default'} />
            ))}
          </div>
        </section>
      )}

      {/* Consolidation */}
      {consolidation?.enabled && (
        <section className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary mb-3">{t('dashboard.consolidation.title')}</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard title={t('dashboard.consolidation.totalRuns')} value={consolidation.totalRuns ?? 0} />
            <MetricCard title={t('dashboard.consolidation.lifetimeSavings')} value={t('dashboard.consolidation.savingsUnit', { count: consolidation.lifetimeSavings ?? 0 })} status="success" />
            {consolidation.totalCostUsd !== undefined && <MetricCard title={t('dashboard.consolidation.cost')} value={`$${consolidation.totalCostUsd.toFixed(3)}`} />}
          </div>
        </section>
      )}

      {/* Deployment */}
      {deployment?.enabled && deployment.stats && (
        <section className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary mb-3">{t('dashboard.deployments.title')}</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard title={t('dashboard.deployments.total')} value={deployment.stats.totalDeployments} />
            <MetricCard title={t('dashboard.deployments.successful')} value={deployment.stats.successful} status="success" />
            <MetricCard title={t('dashboard.deployments.failed')} value={deployment.stats.failed} trend={deployment.stats.failed > 0 ? 'down' : 'neutral'} status={deployment.stats.failed > 0 ? 'error' : 'default'} />
            <MetricCard title={t('dashboard.deployments.circuitBreaker')} value={deployment.stats.circuitBreakerState} />
          </div>
        </section>
      )}

      {/* Maintenance */}
      {maintenance?.decay?.enabled && (
        <section className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary mb-3">{t('dashboard.maintenance.title')}</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard title={t('dashboard.maintenance.memoryDecay')} value={maintenance.decay.enabled ? t('dashboard.maintenance.memoryDecayActive') : t('dashboard.maintenance.memoryDecayDisabled')} status={maintenance.decay.enabled ? 'success' : 'default'} />
            <MetricCard title={t('dashboard.maintenance.exemptDomains')} value={maintenance.decay.totalExempt ?? 0} />
            {maintenance.pruning && <MetricCard title={t('dashboard.maintenance.triggerPruning')} value={t('dashboard.maintenance.retentionDays', { days: maintenance.pruning.retentionDays })} subtitle={t('dashboard.maintenance.lastPruned', { count: maintenance.pruning.lastPrunedCount })} />}
          </div>
        </section>
      )}

      {/* Security */}
      {metrics?.securityStats && (metrics.securityStats.secretsSanitized > 0 || metrics.securityStats.toolsBlocked > 0) && (
        <section className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary mb-3">{t('dashboard.security.title')}</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard title={t('dashboard.security.secretsSanitized')} value={metrics.securityStats.secretsSanitized} status={metrics.securityStats.secretsSanitized > 0 ? 'warning' : 'default'} />
            <MetricCard title={t('dashboard.security.toolsBlocked')} value={metrics.securityStats.toolsBlocked} subtitle={metrics.readOnlyMode ? t('dashboard.security.readOnlyMode') : ''} status={metrics.securityStats.toolsBlocked > 0 ? 'error' : 'default'} />
          </div>
        </section>
      )}
    </div>
  )
}
