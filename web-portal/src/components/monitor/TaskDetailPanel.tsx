import { useMemo } from 'react'
import { useMonitorStore } from '../../stores/monitor-store'
import { BlurFade } from '../ui/blur-fade'

const STATUS_STYLES: Record<string, string> = {
  pending: 'border-white/10 bg-white/5 text-text-secondary',
  executing: 'border-accent/20 bg-accent/10 text-accent',
  verifying: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
  completed: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  failed: 'border-rose-400/25 bg-rose-400/10 text-rose-300',
  skipped: 'border-white/10 bg-white/5 text-text-tertiary',
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

function StatusBadge({
  label,
  value,
  styles,
}: {
  label: string
  value: string
  styles: Record<string, string>
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">
        {label}
      </div>
      <div
        className={`mt-2 inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${styles[value] ?? 'border-white/10 bg-white/5 text-text'}`}
      >
        {normalizeLabel(value)}
      </div>
    </div>
  )
}

export default function TaskDetailPanel() {
  const selectedTaskId = useMonitorStore((s) => s.selectedTaskId)
  const tasks = useMonitorStore((s) => s.tasks)
  const task = selectedTaskId ? tasks[selectedTaskId] : null

  const progressPercent = useMemo(() => {
    if (!task?.progress || task.progress.total <= 0) return null
    return Math.max(0, Math.min(100, Math.round((task.progress.current / task.progress.total) * 100)))
  }, [task])

  if (!task) {
    return (
      <div className="p-4">
        <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-5">
          <div className="text-sm text-text-tertiary">Select a task to see details.</div>
          <div className="mt-2 text-xs leading-5 text-text-secondary">
            Agent owner, review stage, progress, dependencies, and substeps will appear here.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-3">
      <BlurFade key={task.id} duration={0.25} offset={6}>
        <div className="space-y-3">
          <div className="overflow-hidden rounded-2xl border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))]">
            <div className="border-b border-white/6 px-4 py-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-accent/75">
                Task Focus
              </div>
              <h3 className="mt-1 text-base font-semibold text-text">{task.title}</h3>
              <div className="mt-1 text-xs text-text-secondary">
                Node <span className="font-mono text-text">{task.nodeId}</span>
                {task.agentId ? (
                  <>
                    {' '}• Agent <span className="font-mono text-text">{task.agentId}</span>
                  </>
                ) : null}
              </div>
            </div>

            <div className="grid gap-3 px-4 py-3 sm:grid-cols-2">
              <StatusBadge label="Status" value={task.status} styles={STATUS_STYLES} />
              <StatusBadge label="Review" value={task.reviewStatus} styles={REVIEW_STYLES} />
            </div>

            {(progressPercent !== null || task.phase || task.elapsed || task.startedAt || task.completedAt) && (
              <div className="border-t border-white/6 px-4 py-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  {task.progress && progressPercent !== null && (
                    <div className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2">
                      <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">
                        <span>Progress</span>
                        <span>{progressPercent}%</span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/6">
                        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progressPercent}%` }} />
                      </div>
                      <div className="mt-2 text-xs text-text-secondary">
                        {task.progress.current}/{task.progress.total} {task.progress.unit}
                      </div>
                    </div>
                  )}

                  <div className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2 text-xs">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">
                      Runtime
                    </div>
                    <div className="mt-2 space-y-1.5">
                      {task.phase && (
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-text-tertiary">Phase</span>
                          <span className="text-text">{normalizeLabel(task.phase)}</span>
                        </div>
                      )}
                      {formatClockTime(task.startedAt) && (
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-text-tertiary">Started</span>
                          <span className="text-text">{formatClockTime(task.startedAt)}</span>
                        </div>
                      )}
                      {formatClockTime(task.completedAt) && (
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-text-tertiary">Completed</span>
                          <span className="text-text">{formatClockTime(task.completedAt)}</span>
                        </div>
                      )}
                      {formatElapsed(task.elapsed) && (
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-text-tertiary">Elapsed</span>
                          <span className="text-text">{formatElapsed(task.elapsed)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {task.dependencies && task.dependencies.length > 0 && (
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">
                Dependencies
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {task.dependencies.map((dependency) => (
                  <span
                    key={dependency}
                    className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-text"
                  >
                    {dependency}
                  </span>
                ))}
              </div>
            </div>
          )}

          {task.substeps && task.substeps.length > 0 && (
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">
                Substeps
              </div>
              <div className="mt-2 space-y-2">
                {task.substeps
                  .slice()
                  .sort((left, right) => left.order - right.order)
                  .map((substep) => (
                    <div
                      key={substep.id}
                      className="rounded-xl border border-white/8 bg-black/15 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm text-text">{substep.label}</div>
                        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-secondary">
                          {normalizeLabel(substep.status)}
                        </span>
                      </div>
                      {substep.files && substep.files.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {substep.files.map((file) => (
                            <span
                              key={file}
                              className="rounded-full bg-white/5 px-2 py-0.5 font-mono text-[10px] text-text-secondary"
                            >
                              {file}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      </BlurFade>
    </div>
  )
}
