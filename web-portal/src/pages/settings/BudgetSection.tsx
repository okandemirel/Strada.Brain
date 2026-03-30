import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useBudget, useBudgetHistory } from '../../hooks/use-api'
import { PageError } from '../../components/ui/page-error'
import { Sparkline } from '../../components/ui/sparkline'

function ProgressBar({ pct, className = '' }: { pct: number; className?: string }) {
  const color = pct >= 1 ? 'bg-red-500' : pct >= 0.8 ? 'bg-yellow-500' : 'bg-[var(--color-accent)]'
  return (
    <div className={`h-2 bg-white/5 rounded-full overflow-hidden ${className}`}>
      <div
        className={`h-full rounded-full transition-all duration-500 ${color}`}
        style={{ width: `${Math.min(pct * 100, 100)}%` }}
      />
    </div>
  )
}

function EditableLimit({ value, onSave, unlimitedLabel, saveLabel, cancelLabel }: { value: number; onSave: (v: number) => void; unlimitedLabel: string; saveLabel: string; cancelLabel: string }) {
  const [editing, setEditing] = useState(false)
  const [input, setInput] = useState(String(value))

  const save = () => {
    const n = parseFloat(input)
    if (Number.isFinite(n) && n >= 0) {
      onSave(n)
      setEditing(false)
    }
  }

  if (!editing) {
    return (
      <button
        onClick={() => { setInput(String(value)); setEditing(true) }}
        className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-accent font-mono text-sm hover:border-accent/50 transition-colors"
      >
        {value === 0 ? unlimitedLabel : `$${value.toFixed(2)}`}
      </button>
    )
  }
  return (
    <div className="flex gap-1.5">
      <input
        type="number"
        min={0}
        step={0.01}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && save()}
        className="w-24 px-2.5 py-1.5 border border-border rounded-lg bg-input-bg text-text font-mono text-[13px] text-center outline-none focus:border-accent"
        autoFocus
      />
      <button onClick={save} className="px-2 py-1 bg-accent/20 text-accent rounded text-xs">{saveLabel}</button>
      <button onClick={() => setEditing(false)} className="px-2 py-1 bg-white/5 text-text-secondary rounded text-xs">{cancelLabel}</button>
    </div>
  )
}

export default function BudgetSection() {
  const { t } = useTranslation('settings')
  const { data: budget, isLoading, error } = useBudget()
  const { data: history } = useBudgetHistory(7)
  const queryClient = useQueryClient()

  const BREAKDOWN_LABELS: Record<string, string> = {
    daemon: t('budget.breakdownDaemon'),
    agents: t('budget.breakdownAgents'),
    chat: t('budget.breakdownChat'),
    verification: t('budget.breakdownVerification'),
  }

  const updateConfig = useCallback(async (update: Record<string, unknown>) => {
    try {
      const res = await fetch('/api/budget/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      })
      if (!res.ok) throw new Error('Failed to update')
      toast.success(t('budget.toastUpdated'))
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['budget'] }), 500)
    } catch {
      toast.error(t('budget.toastFailed'))
    }
  }, [queryClient, t])

  if (isLoading) {
    return (
      <div>
        <h2 className="text-lg font-semibold text-text mb-1">{t('budget.title')}</h2>
        <p className="text-sm text-text-tertiary">{t('budget.loading')}</p>
      </div>
    )
  }

  if (error || !budget) {
    return <PageError title={t('budget.errorTitle')} message={error instanceof Error ? error.message : t('budget.errorFallback')} />
  }

  const { global, breakdown, config } = budget
  const historyTotals = history?.entries?.map((e) => e.total) ?? []

  const breakdownTotal =
    breakdown.daemon + breakdown.agents + breakdown.chat + breakdown.verification || 1

  return (
    <div>
      <h2 className="text-lg font-semibold text-text mb-1">{t('budget.title')}</h2>
      <p className="text-sm text-text-tertiary mb-6">{t('budget.description')}</p>

      {/* Daily Budget */}
      <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-text">{t('budget.dailyBudget')}</span>
          <EditableLimit
            value={config.dailyLimitUsd}
            onSave={(v) => updateConfig({ dailyLimitUsd: v })}
            unlimitedLabel={t('budget.unlimited')}
            saveLabel={t('budget.save')}
            cancelLabel={t('budget.cancel')}
          />
        </div>
        <ProgressBar pct={global.daily.pct} className="mb-2" />
        <p className="text-xs text-text-secondary">
          <span>{t('budget.usedToday', { amount: `$${global.daily.usedUsd.toFixed(2)}` })}</span>
          {config.dailyLimitUsd > 0 && <span>{t('budget.ofLimit', { limit: `$${config.dailyLimitUsd.toFixed(2)}` })}</span>}
        </p>
      </div>

      {/* Monthly Budget */}
      <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-text">{t('budget.monthlyBudget')}</span>
          <EditableLimit
            value={config.monthlyLimitUsd}
            onSave={(v) => updateConfig({ monthlyLimitUsd: v })}
            unlimitedLabel={t('budget.unlimited')}
            saveLabel={t('budget.save')}
            cancelLabel={t('budget.cancel')}
          />
        </div>
        <ProgressBar pct={global.monthly.pct} className="mb-2" />
        <p className="text-xs text-text-secondary">
          {t('budget.usedThisMonth', { amount: `$${global.monthly.usedUsd.toFixed(2)}` })}
          {config.monthlyLimitUsd > 0 && t('budget.ofLimit', { limit: `$${config.monthlyLimitUsd.toFixed(2)}` })}
        </p>
      </div>

      {/* Sub-Limits */}
      <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3">
        {t('budget.subLimits')}
      </p>
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5">
          <p className="text-xs text-text-tertiary mb-2">{t('budget.daemonDaily')}</p>
          <EditableLimit
            value={config.subLimits.daemonDailyUsd}
            onSave={(v) => updateConfig({ subLimits: { daemonDailyUsd: v } })}
            unlimitedLabel={t('budget.unlimited')}
            saveLabel={t('budget.save')}
            cancelLabel={t('budget.cancel')}
          />
        </div>
        <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5">
          <p className="text-xs text-text-tertiary mb-2">{t('budget.perAgent')}</p>
          <EditableLimit
            value={config.subLimits.agentDefaultUsd}
            onSave={(v) => updateConfig({ subLimits: { agentDefaultUsd: v } })}
            unlimitedLabel={t('budget.unlimited')}
            saveLabel={t('budget.save')}
            cancelLabel={t('budget.cancel')}
          />
        </div>
      </div>

      {/* Today's Breakdown */}
      <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3">
        {t('budget.todaysBreakdown')}
      </p>
      <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-4 space-y-3">
        {(Object.keys(BREAKDOWN_LABELS) as Array<keyof typeof breakdown>).map((key) => {
          const amount = breakdown[key]
          const pct = amount / breakdownTotal
          return (
            <div key={key}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-text-secondary">{BREAKDOWN_LABELS[key]}</span>
                <span className="text-xs font-mono text-text">{`$${amount.toFixed(2)}`}</span>
              </div>
              <ProgressBar pct={pct} />
            </div>
          )
        })}
      </div>

      {/* 7-Day Sparkline */}
      {historyTotals.length >= 2 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3">
            {t('budget.sevenDaySpending')}
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-4">
            <Sparkline data={historyTotals} className="w-full h-10" />
          </div>
        </>
      )}
    </div>
  )
}
