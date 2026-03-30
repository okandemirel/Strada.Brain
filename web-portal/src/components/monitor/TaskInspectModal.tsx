import { useMemo } from 'react'
import { useMonitorStore, type MonitorTask, type ActivityEntry } from '../../stores/monitor-store'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { cn } from '@/lib/utils'

/* ── Status / review colour maps ─────────────────────────────────── */

const STATUS_STYLES: Record<string, string> = {
  pending: 'border-white/10 bg-white/5 text-text-secondary',
  executing: 'border-accent/20 bg-accent/10 text-accent',
  verifying: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
  completed: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  failed: 'border-rose-400/25 bg-rose-400/10 text-rose-300',
  skipped: 'border-white/10 bg-white/5 text-text-tertiary',
  blocked: 'border-orange-400/25 bg-orange-400/10 text-orange-300',
  cancelled: 'border-white/10 bg-white/5 text-text-tertiary',
  paused: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
  waiting_for_input: 'border-sky-400/25 bg-sky-400/10 text-sky-300',
}

const REVIEW_STYLES: Record<string, string> = {
  none: 'border-white/10 bg-white/5 text-text-secondary',
  spec_review: 'border-sky-400/25 bg-sky-400/10 text-sky-300',
  quality_review: 'border-violet-400/25 bg-violet-400/10 text-violet-300',
  review_passed: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  passed: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  failed: 'border-rose-400/25 bg-rose-400/10 text-rose-300',
  review_stuck: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
}

const STATUS_BANNER: Record<string, { bg: string; border: string; icon: string; label: string }> = {
  completed: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', icon: '\u2713', label: 'Task completed successfully' },
  failed: { bg: 'bg-rose-500/10', border: 'border-rose-500/20', icon: '\u2717', label: 'Task failed' },
  executing: { bg: 'bg-accent/10', border: 'border-accent/20', icon: '\u25B6', label: 'Task in progress' },
  pending: { bg: 'bg-white/5', border: 'border-white/10', icon: '\u25CB', label: 'Waiting to start' },
  skipped: { bg: 'bg-white/5', border: 'border-white/10', icon: '\u2192', label: 'Task was skipped' },
  verifying: { bg: 'bg-amber-500/10', border: 'border-amber-500/20', icon: '\u2731', label: 'Verifying output' },
  blocked: { bg: 'bg-orange-500/10', border: 'border-orange-500/20', icon: '\u26A0', label: 'Blocked by dependency' },
  paused: { bg: 'bg-amber-500/10', border: 'border-amber-500/20', icon: '\u23F8', label: 'Paused' },
  waiting_for_input: { bg: 'bg-sky-500/10', border: 'border-sky-500/20', icon: '\u270B', label: 'Waiting for input' },
  cancelled: { bg: 'bg-white/5', border: 'border-white/10', icon: '\u2715', label: 'Cancelled' },
}

const SUBSTEP_ICONS: Record<string, { color: string; icon: string }> = {
  done: { color: 'text-emerald-400', icon: '\u2713' },
  active: { color: 'text-accent', icon: '\u25B6' },
  skipped: { color: 'text-text-tertiary', icon: '\u2014' },
}

/* ── Helpers ──────────────────────────────────────────────────────── */

function formatClockTime(value?: number): string | null {
  if (!value) return null
  return new Date(value).toLocaleTimeString()
}

function formatElapsed(value?: number): string | null {
  if (!value) return null
  if (value < 1000) return `${value}ms`
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`
}

function normalizeLabel(value: string): string {
  return value.replace(/_/g, ' ')
}

function resultToString(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/* ── Sub-components ──────────────────────────────────────────────── */

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

function Section({
  title,
  children,
  className,
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('rounded-xl border border-white/8 bg-white/[0.03]', className)}>
      <div className="px-4 py-2.5">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">
          {title}
        </div>
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
  if (entries.length === 0) {
    return (
      <div className="py-2 text-center text-xs text-text-tertiary">
        No activity recorded for this task.
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
              {new Date(entry.timestamp).toLocaleTimeString()}
            </span>
            <span className="rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 font-semibold uppercase tracking-wide text-text-secondary">
              {entry.action.replace(/_/g, ' ')}
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

/* ── Main modal ──────────────────────────────────────────────────── */

export default function TaskInspectModal() {
  const selectedTaskId = useMonitorStore((s) => s.selectedTaskId)
  const tasks = useMonitorStore((s) => s.tasks)
  const allActivities = useMonitorStore((s) => s.activities)
  const setSelectedTask = useMonitorStore((s) => s.setSelectedTask)

  const task: MonitorTask | null = selectedTaskId ? tasks[selectedTaskId] ?? null : null

  const taskActivities = useMemo(() => {
    if (!task) return []
    return allActivities.filter(
      (a) => a.taskId === task.id || a.taskId === task.nodeId,
    )
  }, [allActivities, task])

  const progressPercent = useMemo(() => {
    if (!task?.progress || task.progress.total <= 0) return null
    return Math.max(0, Math.min(100, Math.round((task.progress.current / task.progress.total) * 100)))
  }, [task?.progress])

  const banner = task ? STATUS_BANNER[task.status] ?? STATUS_BANNER.pending : null

  const implResult = resultToString(task?.implementationResult)
  const specResult = resultToString(task?.specReviewResult)
  const qualityResult = resultToString(task?.qualityReviewResult)

  const handleClose = () => setSelectedTask(null)

  return (
    <Dialog open={!!task} onOpenChange={(open) => { if (!open) handleClose() }}>
      <DialogContent
        className="!max-w-2xl !w-[90vw] !max-h-[85vh] flex flex-col !p-0 overflow-hidden"
        onPointerDownOutside={handleClose}
      >
        {task && (
          <>
            {/* ── Header ─────────────────────────────────────────── */}
            <div className="shrink-0 border-b border-white/8 px-5 pt-5 pb-4">
              <DialogTitle className="text-base font-semibold text-text leading-snug">
                {task.title}
              </DialogTitle>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                <span className="font-mono">{task.nodeId}</span>
                {task.agentId && (
                  <>
                    <span className="text-white/20">|</span>
                    <span>
                      Agent <span className="font-mono text-text">{task.agentId}</span>
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* ── Scrollable body ────────────────────────────────── */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

              {/* Status banner */}
              {banner && (
                <div
                  className={cn(
                    'flex items-center gap-3 rounded-xl border px-4 py-3',
                    banner.bg,
                    banner.border,
                  )}
                >
                  <span className="text-lg">{banner.icon}</span>
                  <div>
                    <div className="text-sm font-medium text-text">{banner.label}</div>
                    {task.status === 'failed' && task.narrative && (
                      <div className="mt-1 text-xs text-rose-300/80">{task.narrative}</div>
                    )}
                  </div>
                </div>
              )}

              {/* Status + Review badges */}
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

              {/* Runtime metrics */}
              {(task.startedAt || task.completedAt || task.elapsed || progressPercent !== null) && (
                <Section title="Runtime">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {/* Progress */}
                    {task.progress && progressPercent !== null && (
                      <div className="rounded-lg border border-white/8 bg-black/15 px-3 py-2.5">
                        <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
                          <span>Progress</span>
                          <span>{progressPercent}%</span>
                        </div>
                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/6">
                          <div
                            className="h-full rounded-full bg-accent transition-all"
                            style={{ width: `${progressPercent}%` }}
                          />
                        </div>
                        <div className="mt-1.5 text-xs text-text-secondary">
                          {task.progress.current}/{task.progress.total} {task.progress.unit}
                        </div>
                      </div>
                    )}

                    {/* Timing */}
                    <div className="space-y-2">
                      {formatClockTime(task.startedAt) && (
                        <MetricRow label="Started" value={formatClockTime(task.startedAt)!} />
                      )}
                      {formatClockTime(task.completedAt) && (
                        <MetricRow label="Completed" value={formatClockTime(task.completedAt)!} />
                      )}
                      {formatElapsed(task.elapsed) && (
                        <MetricRow label="Elapsed" value={formatElapsed(task.elapsed)!} />
                      )}
                    </div>
                  </div>
                </Section>
              )}

              {/* Narrative / milestone */}
              {(task.narrative || task.milestone) && task.status !== 'failed' && (
                <Section title="Latest Update">
                  {task.narrative && (
                    <div className="text-sm leading-relaxed text-text">{task.narrative}</div>
                  )}
                  {task.milestone && (
                    <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-accent/15 bg-accent/10 px-3 py-1 text-xs text-accent">
                      <span className="font-semibold">
                        {task.milestone.current}/{task.milestone.total}
                      </span>
                      <span>{task.milestone.label}</span>
                    </div>
                  )}
                </Section>
              )}

              {/* Dependencies */}
              {task.dependencies && task.dependencies.length > 0 && (
                <Section title="Dependencies">
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

              {/* Substeps */}
              {task.substeps && task.substeps.length > 0 && (
                <Section title={`Substeps (${task.substeps.filter((s) => s.status === 'done').length}/${task.substeps.length})`}>
                  <div className="space-y-2">
                    {task.substeps
                      .slice()
                      .sort((a, b) => a.order - b.order)
                      .map((substep) => {
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
                                    <span
                                      key={file}
                                      className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary"
                                    >
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

              {/* Implementation / Review results */}
              {(implResult || specResult || qualityResult) && (
                <Section title="Results">
                  <div className="space-y-3">
                    {implResult && (
                      <div>
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
                          Implementation
                        </div>
                        <pre className="max-h-[160px] overflow-auto rounded-lg bg-black/20 p-3 font-mono text-xs leading-relaxed text-text-secondary">
                          {implResult}
                        </pre>
                      </div>
                    )}
                    {specResult && (
                      <div>
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
                          Spec Review
                        </div>
                        <pre className="max-h-[160px] overflow-auto rounded-lg bg-black/20 p-3 font-mono text-xs leading-relaxed text-text-secondary">
                          {specResult}
                        </pre>
                      </div>
                    )}
                    {qualityResult && (
                      <div>
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
                          Quality Review
                        </div>
                        <pre className="max-h-[160px] overflow-auto rounded-lg bg-black/20 p-3 font-mono text-xs leading-relaxed text-text-secondary">
                          {qualityResult}
                        </pre>
                      </div>
                    )}
                  </div>
                </Section>
              )}

              {/* Task activity timeline */}
              <Section title={`Activity (${taskActivities.length})`}>
                <TaskActivityTimeline entries={taskActivities} />
              </Section>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
