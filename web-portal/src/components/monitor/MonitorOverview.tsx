import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useMonitorStore } from '../../stores/monitor-store'
import type { TFunction } from 'i18next'

function compactId(value: string | null, t: TFunction): string {
  if (!value) return t('overview.awaitingGoal')
  if (value.length <= 18) return value
  return `${value.slice(0, 10)}...${value.slice(-4)}`
}

function formatLastActivity(detail: string | undefined, t: TFunction): string {
  if (!detail) return t('overview.noLiveActivity')
  return detail.length > 64 ? `${detail.slice(0, 61)}...` : detail
}

function buildFocusSummary(selectedTitle: string | undefined, reviewQueue: number, t: TFunction): string {
  if (selectedTitle) return t('overview.focusedTask', { title: selectedTitle })
  if (reviewQueue > 0) return t('overview.reviewWaiting', { count: reviewQueue })
  return t('overview.selectNodeHint')
}

export default function MonitorOverview() {
  const { t } = useTranslation('monitor')
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
      label: t('overview.statTasks'),
      value: `${summary.running}`,
      meta: summary.total > 0 ? t('overview.totalSuffix', { count: summary.total }) : t('overview.idle'),
      tone: 'text-accent',
    },
    {
      label: t('overview.statReview'),
      value: `${summary.reviewQueue}`,
      meta: summary.verifying > 0 ? t('overview.verifyingSuffix', { count: summary.verifying }) : t('overview.clear'),
      tone: 'text-amber-300',
    },
    {
      label: t('overview.statAgents'),
      value: `${summary.agentCount}`,
      meta: summary.blocked > 0 ? t('overview.blockedSuffix', { count: summary.blocked }) : t('overview.healthy'),
      tone: summary.blocked > 0 ? 'text-rose-300' : 'text-emerald-300',
    },
    {
      label: t('overview.statProgress'),
      value: `${summary.completionRatio}%`,
      meta: t('overview.doneFraction', { completed: summary.completed, total: summary.total }),
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
                {t('overview.missionControl')}
              </div>
              <div className="mt-1 text-lg font-semibold text-text">{t('overview.cockpitTitle')}</div>
              <div className="mt-1 text-sm text-text-secondary">
                {t('overview.rootGoal')} <span className="text-text">{compactId(activeRootId, t)}</span>
              </div>
            </div>

            <div className="min-w-[220px] max-w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">
                {t('overview.liveFeed')}
              </div>
              <div className="mt-1 text-sm text-text">
                {formatLastActivity(summary.lastActivity?.detail, t)}
              </div>
            </div>
          </div>

          <div className="mt-3 text-sm text-text-secondary">
            {buildFocusSummary(summary.selectedTask?.title, summary.reviewQueue, t)}
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
