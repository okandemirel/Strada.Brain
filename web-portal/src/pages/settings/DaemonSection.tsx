import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useDaemon } from '../../hooks/use-api'

export default function DaemonSection() {
  const { t } = useTranslation('settings')
  const { data: daemon, isLoading } = useDaemon()
  const queryClient = useQueryClient()
  const [toggling, setToggling] = useState(false)

  const toggle = useCallback(async () => {
    if (!daemon) return
    const action = daemon.running ? 'stop' : 'start'
    setToggling(true)
    try {
      const res = await fetch(`/api/daemon/${action}`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed')
      toast.success(action === 'stop' ? t('daemon.toastStopped') : t('daemon.toastStarted'))
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['daemon'] }), 600)
    } catch {
      toast.error(t('daemon.toastFailed', { action }))
    } finally {
      setToggling(false)
    }
  }, [daemon, queryClient, t])

  if (isLoading || !daemon) {
    return (
      <div>
        <h2 className="text-lg font-semibold text-text mb-1">{t('daemon.title')}</h2>
        <p className="text-sm text-text-tertiary">{t('daemon.loading')}</p>
      </div>
    )
  }

  const { running, budget, triggers, approvalQueue, startupNotices, identity } = daemon

  return (
    <div>
      <h2 className="text-lg font-semibold text-text mb-1">{t('daemon.title')}</h2>
      <p className="text-sm text-text-tertiary mb-6">{t('daemon.description')}</p>

      {/* Status + Toggle */}
      <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
        {t('daemon.status')}
      </p>
      <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-4">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-3">
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${running ? 'bg-green-400' : 'bg-white/20'}`} />
            <span className="text-sm font-medium text-text">{running ? t('daemon.running') : t('daemon.stopped')}</span>
          </div>
          <button
            onClick={toggle}
            disabled={toggling}
            className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 ${running ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25' : 'bg-green-500/15 text-green-400 hover:bg-green-500/25'}`}
          >
            {toggling ? '...' : running ? t('daemon.stop') : t('daemon.start')}
          </button>
        </div>
        {identity && (
          <div className="mt-3 space-y-1.5 text-xs text-text-secondary">
            <div className="flex justify-between">
              <span>{t('daemon.agent')}</span>
              <span className="font-mono text-text">{identity.agentName}</span>
            </div>
            <div className="flex justify-between">
              <span>{t('daemon.bootCount')}</span>
              <span className="font-mono text-text">{identity.bootCount}</span>
            </div>
            <div className="flex justify-between">
              <span>{t('daemon.lastBoot')}</span>
              <span className="text-text">{identity.lastBoot}</span>
            </div>
          </div>
        )}
      </div>

      {/* Budget */}
      <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
        {t('daemon.budget')}
      </p>
      <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-4">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-text-secondary">{t('daemon.used')}</span>
          <span className="text-sm font-mono text-text">{`$${budget.usedUsd.toFixed(2)}`}</span>
        </div>
        <div className="h-2 bg-white/5 rounded-full overflow-hidden mb-2">
          <div
            className={`h-full rounded-full transition-all duration-500 ${budget.pct >= 1 ? 'bg-red-500' : budget.pct >= 0.8 ? 'bg-yellow-500' : 'bg-[var(--color-accent)]'}`}
            style={{ width: `${Math.min(budget.pct * 100, 100)}%` }}
          />
        </div>
        <p className="text-xs text-text-tertiary">
          {budget.limitUsd > 0 ? t('daemon.limit', { amount: `$${budget.limitUsd.toFixed(2)}` }) : t('daemon.noLimit')}
        </p>
      </div>

      {/* Triggers */}
      {triggers.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
            {t('daemon.triggers', { count: triggers.length })}
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl mb-4 overflow-hidden">
            {triggers.map((tr, i) => (
              <div
                key={`${tr.name}-${i}`}
                className={`flex justify-between items-center px-4 py-2.5 text-sm ${i < triggers.length - 1 ? 'border-b border-white/5' : ''}`}
              >
                <div>
                  <span className="text-text font-medium">{tr.name}</span>
                  <span className="text-text-tertiary text-xs ml-2">{tr.type}</span>
                </div>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${tr.state === 'active' ? 'bg-green-500/15 text-green-400' : tr.circuitState === 'open' ? 'bg-red-500/15 text-red-400' : 'bg-white/5 text-text-secondary'}`}>
                  {tr.circuitState === 'open' ? t('daemon.circuitOpen') : tr.state}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Approval Queue */}
      {approvalQueue && approvalQueue.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
            {t('daemon.approvalQueue', { count: approvalQueue.length })}
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl mb-4 overflow-hidden">
            {approvalQueue.map((item, i) => (
              <div
                key={item.id}
                className={`flex justify-between items-center px-4 py-2.5 text-sm ${i < approvalQueue.length - 1 ? 'border-b border-white/5' : ''}`}
              >
                <div>
                  <span className="text-text font-medium">{item.toolName}</span>
                  {item.triggerName && (
                    <span className="text-text-tertiary text-xs ml-2">{t('daemon.via', { name: item.triggerName })}</span>
                  )}
                </div>
                <span className="text-xs text-text-secondary">{item.status}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Startup Notices */}
      {startupNotices && startupNotices.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
            {t('daemon.startupNotices')}
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-4 mb-4 space-y-1.5">
            {startupNotices.map((notice, i) => (
              <p key={i} className="text-xs text-text-secondary">{notice}</p>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

