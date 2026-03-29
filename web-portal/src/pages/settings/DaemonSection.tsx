import { useState, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useDaemon } from '../../hooks/use-api'

export default function DaemonSection() {
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
      toast.success(`Daemon ${action}ed`)
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['daemon'] }), 600)
    } catch {
      toast.error(`Failed to ${action} daemon`)
    } finally {
      setToggling(false)
    }
  }, [daemon, queryClient])

  if (isLoading || !daemon) {
    return (
      <div>
        <h2 className="text-lg font-semibold text-text mb-1">Daemon</h2>
        <p className="text-sm text-text-tertiary">Loading...</p>
      </div>
    )
  }

  const { running, budget, triggers, approvalQueue, startupNotices, identity } = daemon

  return (
    <div>
      <h2 className="text-lg font-semibold text-text mb-1">Daemon</h2>
      <p className="text-sm text-text-tertiary mb-6">Background task automation</p>

      {/* Status + Toggle */}
      <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
        Status
      </p>
      <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-4">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-3">
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${running ? 'bg-green-400' : 'bg-white/20'}`} />
            <span className="text-sm font-medium text-text">{running ? 'Running' : 'Stopped'}</span>
          </div>
          <button
            onClick={toggle}
            disabled={toggling}
            className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 ${running ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25' : 'bg-green-500/15 text-green-400 hover:bg-green-500/25'}`}
          >
            {toggling ? '...' : running ? 'Stop' : 'Start'}
          </button>
        </div>
        {identity && (
          <div className="mt-3 space-y-1.5 text-xs text-text-secondary">
            <div className="flex justify-between">
              <span>Agent</span>
              <span className="font-mono text-text">{identity.agentName}</span>
            </div>
            <div className="flex justify-between">
              <span>Boot count</span>
              <span className="font-mono text-text">{identity.bootCount}</span>
            </div>
            <div className="flex justify-between">
              <span>Last boot</span>
              <span className="text-text">{identity.lastBoot}</span>
            </div>
          </div>
        )}
      </div>

      {/* Budget */}
      <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
        Budget
      </p>
      <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-4">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-text-secondary">Used</span>
          <span className="text-sm font-mono text-text">{`$${budget.usedUsd.toFixed(2)}`}</span>
        </div>
        <div className="h-2 bg-white/5 rounded-full overflow-hidden mb-2">
          <div
            className={`h-full rounded-full transition-all duration-500 ${budget.pct >= 1 ? 'bg-red-500' : budget.pct >= 0.8 ? 'bg-yellow-500' : 'bg-[var(--color-accent)]'}`}
            style={{ width: `${Math.min(budget.pct * 100, 100)}%` }}
          />
        </div>
        <p className="text-xs text-text-tertiary">
          {budget.limitUsd > 0 ? `Limit: $${budget.limitUsd.toFixed(2)}` : 'No limit set'}
        </p>
      </div>

      {/* Triggers */}
      {triggers.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
            {`Triggers (${triggers.length})`}
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl mb-4 overflow-hidden">
            {triggers.map((t, i) => (
              <div
                key={`${t.name}-${i}`}
                className={`flex justify-between items-center px-4 py-2.5 text-sm ${i < triggers.length - 1 ? 'border-b border-white/5' : ''}`}
              >
                <div>
                  <span className="text-text font-medium">{t.name}</span>
                  <span className="text-text-tertiary text-xs ml-2">{t.type}</span>
                </div>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${t.state === 'active' ? 'bg-green-500/15 text-green-400' : t.circuitState === 'open' ? 'bg-red-500/15 text-red-400' : 'bg-white/5 text-text-secondary'}`}>
                  {t.circuitState === 'open' ? 'circuit-open' : t.state}
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
            {`Approval Queue (${approvalQueue.length})`}
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
                    <span className="text-text-tertiary text-xs ml-2">via {item.triggerName}</span>
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
            Startup Notices
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

