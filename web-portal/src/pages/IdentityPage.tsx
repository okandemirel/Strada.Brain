import { useTranslation } from 'react-i18next'
import { formatUptime } from '../utils/format'
import { useDaemon, useMetrics } from '../hooks/use-api'
import { PageSkeleton } from '../components/ui/page-skeleton'
import { PageError } from '../components/ui/page-error'

function formatDate(ts: string): string {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ts
  }
}

function toPercent(pct: number): number {
  return pct * 100
}

export default function IdentityPage() {
  const { t: t_i18n } = useTranslation('pages')
  const daemonQuery = useDaemon()
  const metricsQuery = useMetrics()

  const loading = daemonQuery.isLoading && metricsQuery.isLoading
  const error = daemonQuery.error && metricsQuery.error
    ? daemonQuery.error.message
    : null

  if (loading) return <PageSkeleton />
  if (error && !daemonQuery.data) return <PageError title={t_i18n('identity.errorTitle')} message={error} />

  const daemon = daemonQuery.data ?? null
  const uptime = metricsQuery.data?.uptime ? metricsQuery.data.uptime / 1000 : 0
  const identity = daemon?.identity
  const daemonBudgetPercent = daemon ? toPercent(daemon.budget.pct) : 0

  return (
    <div className="h-full overflow-y-auto p-7 w-full animate-[admin-fade-in_0.3s_ease]">
      <h2 className="text-[22px] font-bold tracking-tight mb-6 text-text">{t_i18n('identity.title')}</h2>

      <div className="mb-7">
        <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">{t_i18n('identity.agentIdentity')}</div>
        {identity ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3.5">
            <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-[18px] flex flex-col gap-2.5 transition-all duration-200 hover:border-border-hover hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]">
              <div className="flex items-center justify-between gap-2.5">
                <span className="text-[15px] font-semibold text-text tracking-tight">{identity.agentName}</span>
                <span className="inline-block text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-[0.04em] bg-accent/10 text-accent">v{identity.version}</span>
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex justify-between items-center text-[13px]">
                  <span className="text-text-secondary">{t_i18n('identity.mode')}</span>
                  <span className="text-text font-medium">{identity.mode}</span>
                </div>
                <div className="flex justify-between items-center text-[13px]">
                  <span className="text-text-secondary">{t_i18n('identity.bootCount')}</span>
                  <span className="text-text font-medium">{identity.bootCount}</span>
                </div>
                <div className="flex justify-between items-center text-[13px]">
                  <span className="text-text-secondary">{t_i18n('identity.firstBoot')}</span>
                  <span className="text-text font-medium">{formatDate(identity.firstBoot)}</span>
                </div>
                <div className="flex justify-between items-center text-[13px]">
                  <span className="text-text-secondary">{t_i18n('identity.lastBoot')}</span>
                  <span className="text-text font-medium">{formatDate(identity.lastBoot)}</span>
                </div>
              </div>
            </div>
            <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-[18px] flex flex-col gap-2.5 transition-all duration-200 hover:border-border-hover hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]">
              <div className="flex items-center justify-between gap-2.5">
                <span className="text-[15px] font-semibold text-text tracking-tight">{t_i18n('identity.continuity')}</span>
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex justify-between items-center text-[13px]">
                  <span className="text-text-secondary">{t_i18n('identity.hash')}</span>
                  <span className="text-text font-medium font-mono text-xs">{identity.continuityHash}</span>
                </div>
                <div className="flex justify-between items-center text-[13px]">
                  <span className="text-text-secondary">{t_i18n('identity.uptime')}</span>
                  <span className="text-text font-medium">{formatUptime(uptime)}</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-[200px] gap-2.5 text-text-secondary text-center">
            <h3 className="text-text text-lg font-semibold">{t_i18n('identity.noIdentityTitle')}</h3>
            <p className="text-sm max-w-[400px]">{t_i18n('identity.noIdentityDescription')}</p>
          </div>
        )}
      </div>

      {daemon && (
        <div className="mb-7">
          <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">{t_i18n('identity.daemonStatus')}</div>
          <div className="flex gap-2.5 flex-wrap mb-4">
            <div className="flex-1 min-w-[150px] flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
              <span className="text-text-secondary">{t_i18n('identity.running')}</span>
              <span className="text-text font-semibold flex items-center gap-1.5">
                <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${daemon.running ? 'bg-success shadow-[0_0_6px_var(--color-success)]' : 'bg-text-tertiary'}`} />
                {daemon.running ? t_i18n('identity.runningYes') : t_i18n('identity.runningNo')}
              </span>
            </div>
            <div className="flex-1 min-w-[150px] flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
              <span className="text-text-secondary">{t_i18n('identity.budgetUsed')}</span>
              <span className="text-text font-semibold">
                ${daemon.budget.usedUsd.toFixed(2)}
                {daemon.budget.limitUsd > 0 && ` / $${daemon.budget.limitUsd.toFixed(2)}`}
              </span>
            </div>
            {daemon.budget.limitUsd > 0 && (
              <div className="flex-1 min-w-[150px] flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
                <span className="text-text-secondary">{t_i18n('identity.budgetPercent')}</span>
                <span className="text-text font-semibold">{daemonBudgetPercent.toFixed(1)}%</span>
              </div>
            )}
          </div>

          {daemon.budget.limitUsd > 0 && (
            <div className="h-2 bg-bg-tertiary rounded overflow-hidden mb-5">
              <div
                className={`h-full rounded transition-[width] duration-400 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] min-w-[2px] ${daemonBudgetPercent > 90 ? 'bg-error' : daemonBudgetPercent > 70 ? 'bg-warning' : 'bg-accent'}`}
                style={{ width: `${Math.min(daemonBudgetPercent, 100)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {daemon?.triggers && daemon.triggers.length > 0 && (
        <div className="mb-7">
          <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">{t_i18n('identity.triggers', { count: daemon.triggers.length })}</div>
          <table className="w-full bg-white/3 backdrop-blur border border-white/5 rounded-2xl overflow-hidden" style={{ borderSpacing: 0, borderCollapse: 'separate' }}>
            <thead>
              <tr>
                <th className="px-4 py-2.5 text-left bg-white/5 font-semibold text-text-secondary text-[11px] uppercase tracking-[0.04em] border-b border-white/5">{t_i18n('identity.triggersColumnName')}</th>
                <th className="px-4 py-2.5 text-left bg-white/5 font-semibold text-text-secondary text-[11px] uppercase tracking-[0.04em] border-b border-white/5">{t_i18n('identity.triggersColumnType')}</th>
                <th className="px-4 py-2.5 text-left bg-white/5 font-semibold text-text-secondary text-[11px] uppercase tracking-[0.04em] border-b border-white/5">{t_i18n('identity.triggersColumnState')}</th>
                <th className="px-4 py-2.5 text-left bg-white/5 font-semibold text-text-secondary text-[11px] uppercase tracking-[0.04em] border-b border-white/5">{t_i18n('identity.triggersColumnCircuit')}</th>
              </tr>
            </thead>
            <tbody>
              {daemon.triggers.map(t => (
                <tr key={t.name} className="hover:bg-white/5">
                  <td className="px-4 py-2.5 text-[13px] border-b border-border font-mono text-xs">{t.name}</td>
                  <td className="px-4 py-2.5 text-[13px] border-b border-border">{t.type}</td>
                  <td className="px-4 py-2.5 text-[13px] border-b border-border">
                    <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${t.state === 'running' || t.state === 'enabled' ? 'bg-success shadow-[0_0_6px_var(--color-success)]' : t.state === 'paused' ? 'bg-warning shadow-[0_0_6px_var(--color-warning)]' : 'bg-text-tertiary'}`} />{' '}
                    {t.state}
                  </td>
                  <td className="px-4 py-2.5 text-[13px] border-b border-border">
                    <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-[0.04em] ${t.circuitState === 'CLOSED' ? 'bg-accent/10 text-accent' : t.circuitState === 'OPEN' ? 'bg-error/10 text-error' : 'bg-warning/10 text-warning'}`}>
                      {t.circuitState ?? t_i18n('identity.circuitNA')}
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
