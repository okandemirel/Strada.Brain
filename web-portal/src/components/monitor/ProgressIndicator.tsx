import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MonitorTask } from '../../stores/monitor-store'
import { formatElapsed } from './monitor-utils'

/**
 * A live elapsed-time readout for an executing task. Ticks client-side once per second from
 * `startedAt` so the display advances even between backend narrative throttles — this is the single
 * most important "it's alive" signal. Falls back to the server-computed `fallbackElapsed` when no
 * `startedAt` is present. The interval runs ONLY while the task is executing and is cleared on
 * unmount / prop change. Purely presentational: it reads progress the backend already streams; it
 * does not change any budget, gating, or decomposition.
 */
export function ElapsedTimer({
  startedAt,
  fallbackElapsed,
}: {
  startedAt?: number
  fallbackElapsed?: number
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (startedAt == null) return
    // Tick once per second so the elapsed readout advances even between backend narrative
    // throttles. The initial `now` (lazy useState) is already current; the interval keeps it fresh.
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])

  const elapsedMs =
    startedAt != null ? Math.max(0, now - startedAt) : fallbackElapsed
  const label = formatElapsed(elapsedMs)
  if (label == null) return null
  return <span className="tabular-nums">{label}</span>
}

/** Resolve the most informative one-line "currently working on X" text the task carries. */
function resolveActivityText(task: MonitorTask, working: string): string {
  if (task.narrative && task.narrative.trim().length > 0) return task.narrative.trim()
  if (task.milestone) return `${task.milestone.current}/${task.milestone.total} ${task.milestone.label}`
  if (task.progress && task.progress.total > 0) {
    return `${task.progress.current}/${task.progress.total} ${task.progress.unit}`
  }
  return working
}

/**
 * Compact executing-only progress footer for the always-visible Kanban card / DAG node. Renders a
 * spinner, a live elapsed timer, the current activity text (narrative → milestone → progress →
 * "Working…"), an optional substep counter, and an optional thin progress bar. Returns null unless
 * the task is executing, so completed/pending cards are unchanged. VISIBILITY ONLY — it surfaces the
 * per-step progress the backend already streams; it adds no logic, events, or budget changes.
 */
export function LiveProgress({ task, condensed = false }: { task: MonitorTask; condensed?: boolean }) {
  const { t } = useTranslation('monitor')
  if (task.status !== 'executing') return null

  const working = t('status.executing')
  const activity = resolveActivityText(task, working)
  const substeps = task.substeps
  const doneCount = substeps?.filter((s) => s.status === 'done').length ?? 0
  const substepTotal = substeps?.length ?? 0
  const progressPercent =
    task.progress && task.progress.total > 0
      ? Math.max(0, Math.min(100, Math.round((task.progress.current / task.progress.total) * 100)))
      : null

  return (
    <div className={cn('mt-2 flex flex-col gap-1 text-[10px] text-text-secondary', condensed && 'mt-1')}>
      <div className="flex items-center gap-1.5">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-accent" aria-hidden />
        <span className="truncate text-text-secondary">{activity}</span>
      </div>
      {!condensed && (
        <div className="flex items-center gap-2 text-text-tertiary">
          <ElapsedTimer startedAt={task.startedAt} fallbackElapsed={task.elapsed} />
          {substepTotal > 0 && (
            <span>{t('progress.stepCounter', { done: doneCount, total: substepTotal })}</span>
          )}
        </div>
      )}
      {condensed && (
        <div className="text-text-tertiary">
          <ElapsedTimer startedAt={task.startedAt} fallbackElapsed={task.elapsed} />
        </div>
      )}
      {!condensed && progressPercent !== null && (
        <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-white/6">
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      )}
    </div>
  )
}
