import { useTranslation } from 'react-i18next'
import { useMemoryStats, useConsolidation, useMaintenance } from '../hooks/use-api'
import { PageSkeleton } from '../components/ui/page-skeleton'
import { PageError } from '../components/ui/page-error'

interface TierInfo {
  name: string
  count: number
  pending: number
  clustered: number
}

export default function MemoryPage() {
  const { t } = useTranslation('pages')
  const memoryQuery = useMemoryStats()
  const consolidationQuery = useConsolidation()
  const maintenanceQuery = useMaintenance()

  const loading = memoryQuery.isLoading && consolidationQuery.isLoading && maintenanceQuery.isLoading
  const error = memoryQuery.error && consolidationQuery.error && maintenanceQuery.error
    ? memoryQuery.error.message
    : null

  const memoryStats = memoryQuery.data?.memory ?? null
  const consolidation = consolidationQuery.data ?? null
  const maintenance = maintenanceQuery.data ?? null

  if (loading) return <PageSkeleton />
  if (error && !memoryStats && !consolidation) return <PageError title={t('memory.errorTitle')} message={error} />

  const tiers: TierInfo[] = []
  if (consolidation?.perTier) {
    for (const [name, data] of Object.entries(consolidation.perTier)) {
      tiers.push({ name, count: data.total, pending: data.pending, clustered: data.clustered })
    }
  } else if (memoryStats?.entriesByTier) {
    for (const [name, count] of Object.entries(memoryStats.entriesByTier)) {
      tiers.push({ name, count, pending: 0, clustered: 0 })
    }
  }

  const totalEntries = memoryStats?.totalEntries ?? tiers.reduce((a, t) => a + t.count, 0)
  const maxTierCount = Math.max(1, ...tiers.map(t => t.count))

  return (
    <div className="h-full overflow-y-auto p-7 w-full animate-[admin-fade-in_0.3s_ease]">
      <h2 className="text-[22px] font-bold tracking-tight mb-6 text-text">{t('memory.title')}</h2>

      <div className="mb-7">
        <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">{t('memory.overview')}</div>
        <div className="flex gap-2.5 flex-wrap mb-5">
          <div className="flex-1 min-w-[150px] flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
            <span className="text-text-secondary">{t('memory.totalEntries')}</span>
            <span className="text-text font-semibold">{totalEntries.toLocaleString()}</span>
          </div>
          {memoryStats && (
            <div className="flex-1 min-w-[150px] flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
              <span className="text-text-secondary">{t('memory.analysisCache')}</span>
              <span className="text-text font-semibold flex items-center gap-1.5">
                <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${memoryStats.hasAnalysisCache ? 'bg-success shadow-[0_0_6px_var(--color-success)]' : 'bg-text-tertiary'}`} />
                {memoryStats.hasAnalysisCache ? t('memory.analysisCacheActive') : t('memory.analysisCacheInactive')}
              </span>
            </div>
          )}
          {consolidation?.enabled !== undefined && (
            <div className="flex-1 min-w-[150px] flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
              <span className="text-text-secondary">{t('memory.consolidation')}</span>
              <span className="text-text font-semibold flex items-center gap-1.5">
                <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${consolidation.enabled ? 'bg-success shadow-[0_0_6px_var(--color-success)]' : 'bg-text-tertiary'}`} />
                {consolidation.enabled ? t('memory.consolidationEnabled') : t('memory.consolidationDisabled')}
              </span>
            </div>
          )}
          {memoryStats?.health && (
            <div className="flex-1 min-w-[150px] flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
              <span className="text-text-secondary">{t('memory.memoryHealth')}</span>
              <span className="text-text font-semibold flex items-center gap-1.5">
                <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${memoryStats.health.healthy ? 'bg-success shadow-[0_0_6px_var(--color-success)]' : 'bg-warning shadow-[0_0_6px_var(--color-warning)]'}`} />
                {memoryStats.health.indexHealth ?? (memoryStats.health.healthy ? t('memory.memoryHealthy') : t('memory.memoryDegraded'))}
              </span>
            </div>
          )}
        </div>
      </div>

      {tiers.length > 0 && (
        <div className="mb-7">
          <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">{t('memory.tierDistribution')}</div>
          {tiers.map(tier => (
            <div key={tier.name} className="flex items-center gap-3.5 px-4 py-3.5 bg-white/3 backdrop-blur border border-white/5 rounded-2xl mb-2.5">
              <span className="text-sm font-semibold text-text min-w-[100px]">{tier.name}</span>
              <div className="flex-1">
                <div className="h-2 bg-bg-tertiary rounded overflow-hidden">
                  <div
                    className="h-full bg-accent rounded transition-[width] duration-400 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] min-w-[2px]"
                    style={{ width: `${(tier.count / maxTierCount) * 100}%` }}
                  />
                </div>
                <div className="flex gap-3 mt-1 text-[11px] text-text-tertiary">
                  <span>{t('memory.clustered', { count: tier.clustered })}</span>
                  <span>{t('memory.pending', { count: tier.pending })}</span>
                </div>
              </div>
              <span className="text-sm font-semibold text-text min-w-[60px] text-right">{tier.count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      {memoryStats?.health && (
        <div className="mb-7">
          <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">{t('memory.indexHealth')}</div>
          <div className="flex gap-2.5 flex-wrap">
            {memoryStats.health.storageUsagePercent !== undefined && (
              <div className="flex-1 min-w-[150px] flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
                <span className="text-text-secondary">{t('memory.storageUsage')}</span>
                <span className="text-text font-semibold">{memoryStats.health.storageUsagePercent}%</span>
              </div>
            )}
            <div className="flex-1 min-w-[150px] flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
              <span className="text-text-secondary">{t('memory.issues')}</span>
              <span className="text-text font-semibold">{memoryStats.health.issues?.length ?? 0}</span>
            </div>
          </div>
          {memoryStats.health.issues && memoryStats.health.issues.length > 0 && (
            <div className="mt-3 text-xs text-text-secondary">
              {memoryStats.health.issues.join(' \u2022 ')}
            </div>
          )}
        </div>
      )}

      {consolidation?.enabled && (
        <div className="mb-7">
          <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">{t('memory.consolidationSection')}</div>
          <div className="flex gap-2.5 flex-wrap">
            {consolidation.totalRuns !== undefined && (
              <div className="flex-1 min-w-[150px] flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
                <span className="text-text-secondary">{t('memory.totalRuns')}</span>
                <span className="text-text font-semibold">{consolidation.totalRuns}</span>
              </div>
            )}
            {consolidation.lifetimeSavings !== undefined && (
              <div className="flex-1 min-w-[150px] flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
                <span className="text-text-secondary">{t('memory.entriesSaved')}</span>
                <span className="text-text font-semibold">{consolidation.lifetimeSavings}</span>
              </div>
            )}
            {consolidation.totalCostUsd !== undefined && (
              <div className="flex-1 min-w-[150px] flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
                <span className="text-text-secondary">{t('memory.totalCost')}</span>
                <span className="text-text font-semibold">${consolidation.totalCostUsd.toFixed(3)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {maintenance?.decay?.enabled && (
        <div className="mb-7">
          <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">{t('memory.memoryDecay')}</div>
          <div className="flex gap-2.5 flex-wrap">
            <div className="flex-1 min-w-[150px] flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
              <span className="text-text-secondary">{t('memory.decay')}</span>
              <span className="text-text font-semibold flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full shrink-0 bg-success shadow-[0_0_6px_var(--color-success)]" /> {t('memory.decayActive')}
              </span>
            </div>
            {maintenance.decay.totalExempt !== undefined && (
              <div className="flex-1 min-w-[150px] flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
                <span className="text-text-secondary">{t('memory.exemptDomains')}</span>
                <span className="text-text font-semibold">{maintenance.decay.totalExempt}</span>
              </div>
            )}
            {maintenance.pruning && (
              <>
                <div className="flex-1 min-w-[150px] flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
                  <span className="text-text-secondary">{t('memory.retention')}</span>
                  <span className="text-text font-semibold">{t('memory.retentionDays', { days: maintenance.pruning.retentionDays })}</span>
                </div>
                <div className="flex-1 min-w-[150px] flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
                  <span className="text-text-secondary">{t('memory.lastPruned')}</span>
                  <span className="text-text font-semibold">{t('memory.lastPrunedEntries', { count: maintenance.pruning.lastPrunedCount })}</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {!memoryStats && tiers.length === 0 && !consolidation?.enabled && !maintenance?.decay?.enabled && (
        <div className="flex flex-col items-center justify-center h-[200px] gap-2.5 text-text-secondary text-center">
          <h3 className="text-text text-lg font-semibold">{t('memory.noDataTitle')}</h3>
          <p className="text-sm max-w-[400px]">{t('memory.noDataDescription')}</p>
        </div>
      )}
    </div>
  )
}
