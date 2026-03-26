import { useMemo } from 'react'
import { useMonitorStore } from '../../stores/monitor-store'

function compactId(value: string | null): string {
  if (!value) return 'Awaiting goal'
  if (value.length <= 18) return value
  return `${value.slice(0, 10)}...${value.slice(-4)}`
}

function formatLastActivity(detail: string | undefined): string {
  if (!detail) return 'No live activity yet'
  return detail.length > 64 ? `${detail.slice(0, 61)}...` : detail
}

export default function MonitorOverview() {
  const tasks = useMonitorStore((s) => s.tasks)
  const activities = useMonitorStore((s) => s.activities)
  const activeRootId = useMonitorStore((s) => s.activeRootId)
  const selectedTaskId = useMonitorStore((s) => s.selectedTaskId)

  const summary = useMemo(() => {
    const allTasks = Object.values(tasks)
    const running = allTasks.filter((task) => task.status === 'executing').length
    const verifying = allTasks.filter((task) => task.status === 'verifying').length
    const completed = allTasks.filter((task) => task.status === 'completed').length
    const blocked = allTasks.filter((task) => task.status === 'failed' || task.reviewStatus === 'review_stuck').length
    const reviewQueue = allTasks.filter((task) =>
      ['spec_review', 'quality_review', 'review_stuck'].includes(task.reviewStatus),
    ).length
    const agentCount = new Set(allTasks.map((task) => task.agentId).filter(Boolean)).size
    const selectedTask = selectedTaskId ? tasks[selectedTaskId] : null
    const lastActivity = activities.at(-1)
    const completionRatio = allTasks.length > 0 ? Math.round((completed / allTasks.length) * 100) : 0

    return {
      running,
      verifying,
      completed,
      blocked,
      reviewQueue,
      agentCount,
      selectedTask,
      lastActivity,
      total: allTasks.length,
      completionRatio,
    }
  }, [activities, selectedTaskId, tasks])

  const statCards = [
    {
      label: 'Execution',
      value: `${summary.running}`,
      meta: summary.total > 0 ? `${summary.total} total tasks` : 'No tasks yet',
      tone: 'text-accent',
    },
    {
      label: 'Review Gates',
      value: `${summary.reviewQueue}`,
      meta: summary.verifying > 0 ? `${summary.verifying} verifying` : 'No active gate',
      tone: 'text-amber-300',
    },
    {
      label: 'Agents',
      value: `${summary.agentCount}`,
      meta: summary.blocked > 0 ? `${summary.blocked} blocked` : 'Pipeline healthy',
      tone: summary.blocked > 0 ? 'text-rose-300' : 'text-emerald-300',
    },
    {
      label: 'Progress',
      value: `${summary.completionRatio}%`,
      meta: `${summary.completed}/${summary.total} completed`,
      tone: 'text-text',
    },
  ]

  return (
    <div
      className="border-b border-white/5 bg-[radial-gradient(circle_at_top_left,rgba(0,229,255,0.12),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))]"
      data-testid="monitor-overview"
    >
      <div className="grid gap-3 px-4 py-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3 shadow-[0_18px_60px_rgba(0,0,0,0.18)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-accent/80">
                Mission Control
              </div>
              <div className="mt-1 text-lg font-semibold text-text">Agent execution cockpit</div>
              <div className="mt-1 text-sm text-text-secondary">
                Root goal <span className="text-text">{compactId(activeRootId)}</span>
              </div>
            </div>
            {summary.selectedTask && (
              <div className="rounded-xl border border-accent/15 bg-accent/8 px-3 py-2 text-right">
                <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent/75">
                  Focus
                </div>
                <div className="mt-1 text-sm font-medium text-text">
                  {summary.selectedTask.title}
                </div>
              </div>
            )}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">
                Live Feed
              </div>
              <div className="mt-1 text-sm text-text">
                {formatLastActivity(summary.lastActivity?.detail)}
              </div>
            </div>
            <div className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">
                Operator Hint
              </div>
              <div className="mt-1 text-sm text-text-secondary">
                Select a node to inspect owner, review gates, substeps, and timing.
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {statCards.map((card) => (
            <div
              key={card.label}
              className="rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-3 shadow-[0_18px_40px_rgba(0,0,0,0.14)]"
            >
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-text-tertiary">
                {card.label}
              </div>
              <div className={`mt-2 text-2xl font-semibold ${card.tone}`}>{card.value}</div>
              <div className="mt-1 text-xs text-text-secondary">{card.meta}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
