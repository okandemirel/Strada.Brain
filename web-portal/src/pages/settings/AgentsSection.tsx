import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAgents } from '../../hooks/use-api'

function relativeTime(ts: number, renderNow: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const diffMs = renderNow - ts
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return t('agents.timeJustNow')
  if (diffMin < 60) return t('agents.timeMinutesAgo', { count: diffMin })
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return t('agents.timeHoursAgo', { count: diffH })
  return t('agents.timeDaysAgo', { count: Math.floor(diffH / 24) })
}

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-500/20 text-green-400',
  stopped: 'bg-white/10 text-text-secondary',
  budget_exceeded: 'bg-red-500/20 text-red-400',
}

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] ?? 'bg-white/10 text-text-secondary'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status.replace('_', ' ')}
    </span>
  )
}

export default function AgentsSection() {
  const { t } = useTranslation('settings')
  const { data, isLoading } = useAgents()

  const [renderNow] = useState(() => Date.now())

  if (isLoading || !data) {
    return (
      <div>
        <h2 className="text-lg font-semibold text-text mb-1">{t('agents.title')}</h2>
        <p className="text-sm text-text-tertiary">{t('agents.loading')}</p>
      </div>
    )
  }

  const agents = data.agents ?? []

  return (
    <div>
      <h2 className="text-lg font-semibold text-text mb-1">{t('agents.title')}</h2>
      <p className="text-sm text-text-tertiary mb-6">{t('agents.description')}</p>

      {/* Status overview */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5">
          <p className="text-xs text-text-tertiary mb-1">{t('agents.system')}</p>
          <p className={`text-sm font-semibold ${data.enabled ? 'text-green-400' : 'text-text-secondary'}`}>
            {data.enabled ? t('agents.enabled') : t('agents.disabled')}
          </p>
        </div>
        <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5">
          <p className="text-xs text-text-tertiary mb-1">{t('agents.active')}</p>
          <p className="text-sm font-semibold text-text">{data.activeCount ?? agents.length}</p>
        </div>
        <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5">
          <p className="text-xs text-text-tertiary mb-1">{t('agents.budgetUsed')}</p>
          <p className="text-sm font-mono text-text">
            {data.globalBudget ? `$${data.globalBudget.usedUsd.toFixed(2)}` : '—'}
          </p>
        </div>
      </div>

      {/* Active agents list */}
      {agents.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3">
            {t('agents.activeAgents')}
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl overflow-hidden mb-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-left text-xs text-text-tertiary font-medium px-4 py-3">{t('agents.columnId')}</th>
                  <th className="text-left text-xs text-text-tertiary font-medium px-4 py-3">{t('agents.columnChannel')}</th>
                  <th className="text-left text-xs text-text-tertiary font-medium px-4 py-3">{t('agents.columnStatus')}</th>
                  <th className="text-left text-xs text-text-tertiary font-medium px-4 py-3">{t('agents.columnBudgetCap')}</th>
                  <th className="text-left text-xs text-text-tertiary font-medium px-4 py-3">{t('agents.columnLastActive')}</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.id} className="border-b border-white/5 last:border-0 hover:bg-white/2 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">{agent.key || agent.id.slice(0, 8)}</td>
                    <td className="px-4 py-3 text-xs text-text-secondary capitalize">{agent.channelType}</td>
                    <td className="px-4 py-3"><StatusBadge status={agent.status} /></td>
                    <td className="px-4 py-3 font-mono text-xs text-text">
                      {agent.budgetCapUsd != null ? `$${agent.budgetCapUsd.toFixed(2)}` : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-text-tertiary">{relativeTime(agent.lastActivity, renderNow, t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {agents.length === 0 && (
        <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 text-center">
          <p className="text-sm text-text-tertiary">{t('agents.noActiveAgents')}</p>
        </div>
      )}
    </div>
  )
}
