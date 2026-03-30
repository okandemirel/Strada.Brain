import { useState, useCallback } from 'react'
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

function EditableLimit({ value, onSave }: { value: number; onSave: (v: number) => void }) {
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
        {value === 0 ? 'Unlimited' : `$${value.toFixed(2)}`}
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
      <button onClick={save} className="px-2 py-1 bg-accent/20 text-accent rounded text-xs">Save</button>
      <button onClick={() => setEditing(false)} className="px-2 py-1 bg-white/5 text-text-secondary rounded text-xs">Cancel</button>
    </div>
  )
}

const BREAKDOWN_LABELS: Record<string, string> = {
  daemon: 'daemon',
  agents: 'agents',
  chat: 'chat',
  verification: 'verification',
}

export default function BudgetSection() {
  const { data: budget, isLoading, error } = useBudget()
  const { data: history } = useBudgetHistory(7)
  const queryClient = useQueryClient()

  const updateConfig = useCallback(async (update: Record<string, unknown>) => {
    try {
      const res = await fetch('/api/budget/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      })
      if (!res.ok) throw new Error('Failed to update')
      toast.success('Budget settings updated')
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['budget'] }), 500)
    } catch {
      toast.error('Failed to update budget settings')
    }
  }, [queryClient])

  if (isLoading) {
    return (
      <div>
        <h2 className="text-lg font-semibold text-text mb-1">Budget</h2>
        <p className="text-sm text-text-tertiary">Loading...</p>
      </div>
    )
  }

  if (error || !budget) {
    return <PageError title="Budget Unavailable" message={error instanceof Error ? error.message : 'Enable daemon mode to activate budget tracking.'} />
  }

  const { global, breakdown, config } = budget
  const historyTotals = history?.entries?.map((e) => e.total) ?? []

  const breakdownTotal =
    breakdown.daemon + breakdown.agents + breakdown.chat + breakdown.verification || 1

  return (
    <div>
      <h2 className="text-lg font-semibold text-text mb-1">Budget</h2>
      <p className="text-sm text-text-tertiary mb-6">Manage spending limits across all systems</p>

      {/* Daily Budget */}
      <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-text">Daily Budget</span>
          <EditableLimit
            value={config.dailyLimitUsd}
            onSave={(v) => updateConfig({ dailyLimitUsd: v })}
          />
        </div>
        <ProgressBar pct={global.daily.pct} className="mb-2" />
        <p className="text-xs text-text-secondary">
          <span>{`$${global.daily.usedUsd.toFixed(2)} used today`}</span>
          {config.dailyLimitUsd > 0 && <span>{` of $${config.dailyLimitUsd.toFixed(2)}`}</span>}
        </p>
      </div>

      {/* Monthly Budget */}
      <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-text">Monthly Budget</span>
          <EditableLimit
            value={config.monthlyLimitUsd}
            onSave={(v) => updateConfig({ monthlyLimitUsd: v })}
          />
        </div>
        <ProgressBar pct={global.monthly.pct} className="mb-2" />
        <p className="text-xs text-text-secondary">
          {`$${global.monthly.usedUsd.toFixed(2)} used this month`}
          {config.monthlyLimitUsd > 0 && ` of $${config.monthlyLimitUsd.toFixed(2)}`}
        </p>
      </div>

      {/* Sub-Limits */}
      <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3">
        Sub-Limits
      </p>
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5">
          <p className="text-xs text-text-tertiary mb-2">Daemon Daily</p>
          <EditableLimit
            value={config.subLimits.daemonDailyUsd}
            onSave={(v) => updateConfig({ subLimits: { daemonDailyUsd: v } })}
          />
        </div>
        <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5">
          <p className="text-xs text-text-tertiary mb-2">Per Agent</p>
          <EditableLimit
            value={config.subLimits.agentDefaultUsd}
            onSave={(v) => updateConfig({ subLimits: { agentDefaultUsd: v } })}
          />
        </div>
      </div>

      {/* Today's Breakdown */}
      <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3">
        Today's Breakdown
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
            7-Day Spending
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-4">
            <Sparkline data={historyTotals} className="w-full h-10" />
          </div>
        </>
      )}
    </div>
  )
}
