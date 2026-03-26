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

function buildFocusSummary(selectedTitle: string | undefined, reviewQueue: number): string {
  if (selectedTitle) return `Focused task: ${selectedTitle}`
  if (reviewQueue > 0) return `${reviewQueue} items are waiting for review.`
  return 'Select a node to inspect owner, review gates, substeps, and timing.'
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
      label: 'Tasks',
      value: `${summary.running}`,
      meta: summary.total > 0 ? `${summary.total} total` : 'Idle',
      tone: 'text-accent',
    },
    {
      label: 'Review',
      value: `${summary.reviewQueue}`,
      meta: summary.verifying > 0 ? `${summary.verifying} verifying` : 'Clear',
      tone: 'text-amber-300',
    },
    {
      label: 'Agents',
      value: `${summary.agentCount}`,
      meta: summary.blocked > 0 ? `${summary.blocked} blocked` : 'Healthy',
      tone: summary.blocked > 0 ? 'text-rose-300' : 'text-emerald-300',
    },
    {
      label: 'Progress',
      value: `${summary.completionRatio}%`,
      meta: `${summary.completed}/${summary.total} done`,
      tone: 'text-text',
    },
  ]

  return (
    <div className="h-full overflow-y-auto bg-black/10" data-testid="monitor-overview">
      <div className="px-4 py-3">
        <div className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-accent/75">
                Mission Control
              </div>
              <div className="mt-1 text-lg font-semibold text-text">Agent execution cockpit</div>
              <div className="mt-1 text-sm text-text-secondary">
                Root goal <span className="text-text">{compactId(activeRootId)}</span>
              </div>
            </div>

            <div className="min-w-[220px] max-w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">
                Live Feed
              </div>
              <div className="mt-1 text-sm text-text">
                {formatLastActivity(summary.lastActivity?.detail)}
              </div>
            </div>
          </div>

          <div className="mt-3 text-sm text-text-secondary">
            {buildFocusSummary(summary.selectedTask?.title, summary.reviewQueue)}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {statCards.map((card) => (
              <div
                key={card.label}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-xs"
              >
                <span className="text-text-tertiary">{card.label}</span>
                <span className={`font-semibold ${card.tone}`}>{card.value}</span>
                <span className="text-text-secondary">{card.meta}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
