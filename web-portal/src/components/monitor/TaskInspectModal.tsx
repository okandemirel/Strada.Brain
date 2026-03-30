import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/shallow'
import { useMonitorStore, type ActivityEntry } from '../../stores/monitor-store'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/dialog'
import { cn } from '@/lib/utils'
import {
  STATUS_STYLES,
  REVIEW_STYLES,
  formatClockTime,
  formatElapsed,
  normalizeLabel,
  resultToString,
} from './monitor-utils'

const STATUS_BANNER: Record<string, { bg: string; border: string; icon: string; labelKey: string }> = {
  completed: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', icon: '\u2713', labelKey: 'inspect.bannerCompleted' },
  failed: { bg: 'bg-rose-500/10', border: 'border-rose-500/20', icon: '\u2717', labelKey: 'inspect.bannerFailed' },
  executing: { bg: 'bg-accent/10', border: 'border-accent/20', icon: '\u25B6', labelKey: 'inspect.bannerExecuting' },
  pending: { bg: 'bg-white/5', border: 'border-white/10', icon: '\u25CB', labelKey: 'inspect.bannerPending' },
  skipped: { bg: 'bg-white/5', border: 'border-white/10', icon: '\u2192', labelKey: 'inspect.bannerSkipped' },
  verifying: { bg: 'bg-amber-500/10', border: 'border-amber-500/20', icon: '\u2731', labelKey: 'inspect.bannerVerifying' },
  blocked: { bg: 'bg-orange-500/10', border: 'border-orange-500/20', icon: '\u26A0', labelKey: 'inspect.bannerBlocked' },
  paused: { bg: 'bg-amber-500/10', border: 'border-amber-500/20', icon: '\u23F8', labelKey: 'inspect.bannerPaused' },
  waiting_for_input: { bg: 'bg-sky-500/10', border: 'border-sky-500/20', icon: '\u270B', labelKey: 'inspect.bannerWaitingForInput' },
  cancelled: { bg: 'bg-white/5', border: 'border-white/10', icon: '\u2715', labelKey: 'inspect.bannerCancelled' },
}

const SUBSTEP_ICONS: Record<string, { color: string; icon: string }> = {
  done: { color: 'text-emerald-400', icon: '\u2713' },
  active: { color: 'text-accent', icon: '\u25B6' },
  skipped: { color: 'text-text-tertiary', icon: '\u2014' },
}

const RESULT_SECTIONS = [
  { key: 'implementationResult' as const, labelKey: 'inspect.resultImplementation' },
  { key: 'specReviewResult' as const, labelKey: 'inspect.resultSpecReview' },
  { key: 'qualityReviewResult' as const, labelKey: 'inspect.resultQualityReview' },
]

function Badge({ value, styles }: { value: string; styles: Record<string, string> }) {
  return (
    <span
      className={cn(
        'inline-flex rounded-full border px-2.5 py-1 text-xs font-medium',
        styles[value] ?? 'border-white/10 bg-white/5 text-text',
      )}
    >
      {normalizeLabel(value)}
    </span>
  )
}

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-xl border border-white/8 bg-white/[0.03]', className)}>
      <div className="px-4 py-2.5">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">{title}</div>
      </div>
      <div className="border-t border-white/6 px-4 py-3">{children}</div>
    </div>
  )
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-text-tertiary">{label}</span>
      <span className="text-xs font-medium text-text">{value}</span>
    </div>
  )
}

function TaskActivityTimeline({ entries }: { entries: ActivityEntry[] }) {
  const { t } = useTranslation('monitor')
  if (entries.length === 0) {
    return (
      <div className="py-2 text-center text-xs text-text-tertiary">
        {t('inspect.noActivity')}
      </div>
    )
  }

  return (
    <div className="relative ml-2 max-h-[200px] overflow-y-auto border-l border-white/8">
      {entries.map((entry, i) => (
        <div key={`${entry.timestamp}-${i}`} className="relative pl-4 pb-2 last:pb-0">
          <span className="absolute -left-[4px] top-2 h-2 w-2 rounded-full border border-accent/30 bg-accent/80" />
          <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
            <span className="font-semibold uppercase tracking-wide text-text-tertiary">
              {formatClockTime(entry.timestamp)}
            </span>
            <span className="rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 font-semibold uppercase tracking-wide text-text-secondary">
              {normalizeLabel(entry.action)}
            </span>
            {entry.tool && (
              <span className="rounded-full border border-accent/10 bg-accent/10 px-1.5 py-0.5 font-mono text-accent">
                {entry.tool}
              </span>
            )}
          </div>
          <div className="mt-1 text-xs leading-relaxed text-text-secondary">{entry.detail}</div>
        </div>
      ))}
    </div>
  )
}

export default function TaskInspectModal() {
  const { t } = useTranslation('monitor')
  const { task, tasks, allActivities, setSelectedTask } = useMonitorStore(
    useShallow((s) => ({
      task: s.selectedTaskId ? s.tasks[s.selectedTaskId] ?? null : null,
      tasks: s.tasks,
      allActivities: s.activities,
      setSelectedTask: s.setSelectedTask,
    })),
  )

  const taskId = task?.id
  const taskNodeId = task?.nodeId
  const taskActivities = useMemo(() => {
    if (!taskId) return []
    return allActivities.filter((a) => a.taskId === taskId || a.taskId === taskNodeId)
  }, [allActivities, taskId, taskNodeId])

  const taskSubsteps = task?.substeps
  const { sortedSubsteps, doneCount } = useMemo(() => {
    if (!taskSubsteps?.length) return { sortedSubsteps: [], doneCount: 0 }
    return {
      sortedSubsteps: [...taskSubsteps].sort((a, b) => a.order - b.order),
      doneCount: taskSubsteps.filter((s) => s.status === 'done').length,
    }
  }, [taskSubsteps])

  const implResult = task?.implementationResult
  const specResult = task?.specReviewResult
  const qualityResult = task?.qualityReviewResult
  const resultEntries = useMemo(() => {
    const results = { implementationResult: implResult, specReviewResult: specResult, qualityReviewResult: qualityResult }
    return RESULT_SECTIONS
      .map(({ key, labelKey }) => ({ label: t(labelKey), text: resultToString(results[key as keyof typeof results]) }))
      .filter((r): r is { label: string; text: string } => r.text !== null)
  }, [implResult, specResult, qualityResult, t])

  const progressPercent =
    task?.progress && task.progress.total > 0
      ? Math.max(0, Math.min(100, Math.round((task.progress.current / task.progress.total) * 100)))
      : null

  const banner = task ? STATUS_BANNER[task.status] ?? STATUS_BANNER.pending : null
  const startedStr = formatClockTime(task?.startedAt)
  const completedStr = formatClockTime(task?.completedAt)
  const elapsedStr = formatElapsed(task?.elapsed)

  const handleClose = () => setSelectedTask(null)

  return (
    <Dialog open={!!task} onOpenChange={(open) => { if (!open) handleClose() }}>
      <DialogContent className="!max-w-2xl !w-[90vw] !max-h-[85vh] flex flex-col !p-0 overflow-hidden">
        {task && (
          <>
            <div className="shrink-0 border-b border-white/8 px-5 pt-5 pb-4">
              <DialogTitle className="text-base font-semibold text-text leading-snug">
                {task.title}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {t('inspect.descriptionPrefix')}{task.nodeId}
              </DialogDescription>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                <span className="font-mono">{task.nodeId}</span>
                {task.agentId && (
                  <>
                    <span className="text-white/20">|</span>
                    <span>
                      {t('inspect.agentLabel')} <span className="font-mono text-text">{task.agentId}</span>
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {banner && (
                <div className={cn('flex items-center gap-3 rounded-xl border px-4 py-3', banner.bg, banner.border)}>
                  <span className="text-lg">{banner.icon}</span>
                  <div>
                    <div className="text-sm font-medium text-text">{t(banner.labelKey)}</div>
                    {task.status === 'failed' && task.narrative && (
                      <div className="mt-1 text-xs text-rose-300/80">{task.narrative}</div>
                    )}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Badge value={task.status} styles={STATUS_STYLES} />
                {task.reviewStatus !== 'none' && (
                  <Badge value={task.reviewStatus} styles={REVIEW_STYLES} />
                )}
                {task.phase && (
                  <span className="inline-flex rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-text-secondary">
                    {normalizeLabel(task.phase)}
                  </span>
                )}
              </div>

              {(task.startedAt || task.completedAt || task.elapsed || progressPercent !== null) && (
                <Section title={t('inspect.sectionRuntime')}>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {task.progress && progressPercent !== null && (
                      <div className="rounded-lg border border-white/8 bg-black/15 px-3 py-2.5">
                        <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
                          <span>{t('inspect.progressLabel')}</span>
                          <span>{progressPercent}%</span>
                        </div>
                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/6">
                          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progressPercent}%` }} />
                        </div>
                        <div className="mt-1.5 text-xs text-text-secondary">
                          {task.progress.current}/{task.progress.total} {task.progress.unit}
                        </div>
                      </div>
                    )}
                    <div className="space-y-2">
                      {startedStr && <MetricRow label={t('inspect.startedLabel')} value={startedStr} />}
                      {completedStr && <MetricRow label={t('inspect.completedLabel')} value={completedStr} />}
                      {elapsedStr && <MetricRow label={t('inspect.elapsedLabel')} value={elapsedStr} />}
                    </div>
                  </div>
                </Section>
              )}

              {(task.narrative || task.milestone) && task.status !== 'failed' && (
                <Section title={t('inspect.sectionLatestUpdate')}>
                  {task.narrative && (
                    <div className="text-sm leading-relaxed text-text">{task.narrative}</div>
                  )}
                  {task.milestone && (
                    <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-accent/15 bg-accent/10 px-3 py-1 text-xs text-accent">
                      <span className="font-semibold">{task.milestone.current}/{task.milestone.total}</span>
                      <span>{task.milestone.label}</span>
                    </div>
                  )}
                </Section>
              )}

              {task.dependencies && task.dependencies.length > 0 && (
                <Section title={t('inspect.sectionDependencies')}>
                  <div className="flex flex-wrap gap-2">
                    {task.dependencies.map((dep) => {
                      const depTask = tasks[dep]
                      return (
                        <button
                          key={dep}
                          onClick={() => setSelectedTask(dep)}
                          className={cn(
                            'rounded-full border px-2.5 py-1 text-xs transition-colors hover:border-accent/30',
                            depTask?.status === 'completed'
                              ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300'
                              : depTask?.status === 'failed'
                                ? 'border-rose-400/20 bg-rose-400/10 text-rose-300'
                                : 'border-white/10 bg-white/5 text-text',
                          )}
                        >
                          {depTask ? depTask.title : dep}
                        </button>
                      )
                    })}
                  </div>
                </Section>
              )}

              {sortedSubsteps.length > 0 && (
                <Section title={t('inspect.sectionSubsteps', { done: doneCount, total: sortedSubsteps.length })}>
                  <div className="space-y-2">
                    {sortedSubsteps.map((substep) => {
                      const indicator = SUBSTEP_ICONS[substep.status] ?? SUBSTEP_ICONS.active
                      return (
                        <div
                          key={substep.id}
                          className={cn(
                            'flex items-start gap-2.5 rounded-lg border border-white/6 bg-black/10 px-3 py-2',
                            substep.status === 'skipped' && 'opacity-50',
                          )}
                        >
                          <span className={cn('mt-0.5 text-sm', indicator.color)}>{indicator.icon}</span>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm text-text">{substep.label}</div>
                            {substep.files && substep.files.length > 0 && (
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {substep.files.map((file) => (
                                  <span key={file} className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
                                    {file}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </Section>
              )}

              {resultEntries.length > 0 && (
                <Section title={t('inspect.sectionResults')}>
                  <div className="space-y-3">
                    {resultEntries.map(({ label, text }) => (
                      <div key={label}>
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">{label}</div>
                        <pre className="max-h-[160px] overflow-auto rounded-lg bg-black/20 p-3 font-mono text-xs leading-relaxed text-text-secondary">
                          {text}
                        </pre>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              <Section title={t('inspect.sectionActivity', { count: taskActivities.length })}>
                <TaskActivityTimeline entries={taskActivities} />
              </Section>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
