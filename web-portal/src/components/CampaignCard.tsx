import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCampaignStatus } from '../hooks/use-api'
import { useCampaignStore, pickFreshest } from '../stores/campaign-store'
import { fetchJson } from '../utils/api'
import { formatDurationShort } from '../utils/format'
import type { BuildMeasurement, BuildStatus, CampaignStatus, GuardianStatus, MilestoneStatus } from '../types/build-status'

/** Task statuses that are still in flight (mirrors ACTIVE_STATUSES in the daemon). */
const ACTIVE_TASK_STATES = new Set(['pending', 'executing', 'verifying', 'paused', 'waiting_for_input'])

const STATE_PILL: Record<CampaignStatus['state'], string> = {
  'drafting-gdd': 'bg-accent/10 text-accent',
  'awaiting-approval': 'bg-warning/10 text-warning',
  planning: 'bg-accent/10 text-accent',
  executing: 'bg-accent/10 text-accent',
  done: 'bg-success/10 text-success',
  failed: 'bg-error/10 text-error',
  cancelled: 'bg-white/5 text-text-tertiary',
}

const MILESTONE_DOT: Record<MilestoneStatus['status'], string> = {
  pending: 'bg-white/15',
  running: 'bg-accent animate-pulse',
  green: 'bg-success',
  failed: 'bg-error',
}

const GUARDIAN_DOT: Record<GuardianStatus['lastVerdict'], string> = {
  unknown: 'bg-white/15',
  green: 'bg-success',
  red: 'bg-error',
  blind: 'bg-warning',
}

function MilestoneRow({ m, isCurrent, timeBoxMs, now }: { m: MilestoneStatus; isCurrent: boolean; timeBoxMs: number; now: number }) {
  const { t } = useTranslation()
  const elapsed = m.status === 'running' && m.startedAtMs !== undefined ? now - m.startedAtMs : null
  const fraction = elapsed !== null && timeBoxMs > 0 ? Math.min(1, elapsed / timeBoxMs) : null
  const notes: string[] = []
  if (m.compileVerdict) {
    notes.push(
      !m.compileVerdict.ran
        ? t('dashboard.campaign.compileNotMeasured')
        : m.compileVerdict.ok
          ? t('dashboard.campaign.compileOk')
          : m.compileVerdict.errors !== undefined
            ? t('dashboard.campaign.compileRed', { errors: m.compileVerdict.errors })
            : t('dashboard.campaign.compileRedUncounted'),
    )
  }
  if (m.placeholderArtAtStart) {
    notes.push(t('dashboard.campaign.placeholdersAtStart', m.placeholderArtAtStart))
  }
  if (m.timeBoxEscalations > 0) notes.push(t('dashboard.campaign.narrowings', { count: m.timeBoxEscalations }))
  if (m.structureRefused) notes.push(t('dashboard.campaign.refused'))
  return (
    <li className={`flex flex-col gap-1 py-2 border-b border-white/5 last:border-b-0 ${isCurrent ? '' : 'opacity-80'}`} data-testid={`milestone-${m.id}`}>
      <div className="flex items-center gap-2.5 text-sm">
        <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${MILESTONE_DOT[m.status]}`} aria-label={m.status} />
        <span className="font-mono text-xs text-text-tertiary w-7 shrink-0">{m.id}</span>
        <span className="text-text truncate">{m.title}</span>
        <span className="ml-auto text-xs text-text-secondary tabular-nums whitespace-nowrap">
          {m.status} · {t('dashboard.campaign.attempt', { n: m.attempts, max: m.maxAttempts })}
        </span>
      </div>
      {fraction !== null && elapsed !== null && (
        <div className="flex items-center gap-2 pl-[22px]">
          <div className="h-1 flex-1 rounded bg-white/5 overflow-hidden">
            <div className={`h-full ${fraction >= 1 ? 'bg-error' : fraction >= 0.75 ? 'bg-warning' : 'bg-accent'}`} style={{ width: `${Math.round(fraction * 100)}%` }} />
          </div>
          <span className="text-[11px] text-text-tertiary tabular-nums whitespace-nowrap">
            {fraction >= 1
              ? t('dashboard.campaign.timeBoxExceeded')
              : t('dashboard.campaign.timeBox', { elapsed: formatDurationShort(elapsed), box: formatDurationShort(timeBoxMs) })}
          </span>
        </div>
      )}
      {notes.length > 0 && <div className="pl-[22px] text-[11px] text-text-tertiary">{notes.join(' · ')}</div>}
    </li>
  )
}

function GuardianLine({ g, now }: { g: GuardianStatus; now: number }) {
  const { t } = useTranslation()
  const parts: string[] = [t(`dashboard.campaign.guardianVerdict.${g.lastVerdict}`)]
  parts.push(g.lastCheckedAt > 0 ? t('dashboard.campaign.guardianChecked', { ago: formatDurationShort(now - g.lastCheckedAt) }) : t('dashboard.campaign.guardianNever'))
  if (g.lastVerdict === 'red' && g.lastErrorCount !== undefined) parts.push(t('dashboard.campaign.guardianErrors', { count: g.lastErrorCount }))
  if (g.fixTaskId) {
    parts.push(t('dashboard.campaign.guardianFix', { id: g.fixTaskId, elapsed: formatDurationShort(now - g.fixTaskStartedAt), n: g.fixAttempts, max: g.maxFixAttempts }))
  }
  if (g.escalated) parts.push(t('dashboard.campaign.guardianEscalated'))
  if (g.lastVerdict === 'blind') parts.push(t('dashboard.campaign.guardianBlind', { count: g.blindStreak }))
  return (
    <div className="flex items-start gap-2.5 text-xs" data-testid="guardian-line">
      <span className={`mt-1 inline-block w-2 h-2 rounded-full shrink-0 ${GUARDIAN_DOT[g.lastVerdict]}`} />
      <div>
        <span className="font-semibold text-text">{t('dashboard.campaign.guardian')}</span>
        <span className="text-text-secondary"> — {parts.join(' · ')}</span>
        {g.lastVerdict === 'red' && g.lastDetail && (
          <pre className="mt-1 text-[11px] text-text-tertiary whitespace-pre-wrap break-words max-h-24 overflow-auto">{g.lastDetail}</pre>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, detail, tone }: { label: string; value: string | number; detail?: string; tone?: 'error' | 'warning' | 'success' }) {
  const toneClass = tone === 'error' ? 'text-error' : tone === 'warning' ? 'text-warning' : tone === 'success' ? 'text-success' : 'text-text'
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[11px] uppercase tracking-wide text-text-tertiary">{label}</span>
      <span className={`text-base font-semibold tabular-nums ${toneClass}`}>{value}</span>
      {detail && <span className="text-[11px] text-text-tertiary truncate" title={detail}>{detail}</span>}
    </div>
  )
}

function MeasurementBlock({ m }: { m: BuildMeasurement }) {
  const { t } = useTranslation()
  if (!m.measured) return <p className="text-xs text-warning">{t('dashboard.campaign.notMeasured')}</p>
  const inv = m.artInventory
  return (
    <div className="flex flex-col gap-3" data-testid="measurement">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className={m.refusal ? 'text-error' : 'text-success'}>
          {m.refusal ? `${t('dashboard.campaign.refusal')}: ${m.refusal}` : t('dashboard.campaign.noRefusal')}
        </span>
        <span className="text-text-tertiary whitespace-nowrap">{t('dashboard.campaign.measuredAt', { time: new Date(m.measuredAt).toLocaleTimeString() })}</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <Stat label={t('dashboard.campaign.shippedScenes')} value={m.shippedScenes.length} detail={m.shippedScenes.map((s) => s.split('/').pop()).join(', ')} />
        <Stat label={t('dashboard.campaign.renderers')} value={m.shippedRenderers} detail={t('dashboard.campaign.renderersDetail', { world: m.shippedWorldRenderers, sprite: m.shippedSpriteRenderers, mesh: m.shippedMeshRenderers })} />
        <Stat
          label={t('dashboard.campaign.placeholders')}
          value={inv.placeholderSprites}
          detail={t('dashboard.campaign.placeholdersDetail', { sprites: inv.sprites, bound: m.boundPlaceholderSprites })}
          tone={inv.placeholderSprites > 0 ? 'warning' : 'success'}
        />
        <Stat label={t('dashboard.campaign.audio')} value={inv.audio} detail={t('dashboard.campaign.audioDetail', { short: inv.shortAudio, dup: inv.duplicateAudio })} />
        <Stat
          label={t('dashboard.campaign.unbound')}
          value={m.unbound.prefabs + m.unbound.models + m.unbound.sprites}
          detail={t('dashboard.campaign.unboundDetail', m.unbound)}
          tone={m.unbound.prefabs + m.unbound.models + m.unbound.sprites > 0 ? 'warning' : undefined}
        />
      </div>
      {m.incomplete.length > 0 && (
        <p className="text-[11px] text-warning">{t('dashboard.campaign.incomplete')}: {m.incomplete.join('; ')}</p>
      )}
    </div>
  )
}

export default function CampaignCard({ now: nowOverride }: { now?: number } = {}) {
  const { t } = useTranslation()
  const query = useCampaignStatus()
  const pushed = useCampaignStore((s) => s.pushed)
  const measurement = useCampaignStore((s) => s.measurement)
  const measurementError = useCampaignStore((s) => s.measurementError)
  const measuring = useCampaignStore((s) => s.measuring)
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    if (nowOverride !== undefined) return
    const id = setInterval(() => setTick(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [nowOverride])
  const now = nowOverride ?? tick

  const status: BuildStatus | null = pickFreshest(pushed, query.data)

  const measureNow = async () => {
    const store = useCampaignStore.getState()
    store.setMeasuring(true)
    try {
      const fresh = await fetchJson<BuildStatus>('/api/campaign?measure=1')
      if (fresh?.measurement || fresh?.measurementError) {
        store.setMeasurement(fresh.measurement ?? null, fresh.measurementError ?? null)
      } else {
        store.setMeasurement(null, 'empty response')
      }
    } catch (err) {
      store.setMeasurement(null, err instanceof Error ? err.message : String(err))
    }
  }

  const shownMeasurement = measurement ?? status?.measurement ?? null

  return (
    <section className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-6" data-testid="campaign-card">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t('dashboard.campaign.title')}</h3>
        {status?.campaign && (
          <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg uppercase tracking-[0.03em] ${STATE_PILL[status.campaign.state]}`} data-testid="campaign-state">
            {status.campaign.state}
          </span>
        )}
      </div>

      {!status && query.isError && (
        <p className="text-xs text-warning">{t('dashboard.campaign.unavailable', { error: query.error?.message ?? '' })}</p>
      )}
      {status && !status.campaign && <p className="text-sm text-text-secondary">{t('dashboard.campaign.none')}</p>}

      {status?.campaign && (() => {
        const c = status.campaign
        const green = c.milestones.filter((m) => m.status === 'green').length
        const others = c.activeTasks.filter((task) => task.id !== c.currentTask?.id)
        return (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-text-secondary">
              <span className="font-mono text-text">{c.id}</span>
              {c.gddPath && <span className="font-mono truncate max-w-[40ch]" title={c.gddPath}>{c.gddPath}</span>}
              <span>{t('dashboard.campaign.started', { ago: formatDurationShort(now - c.createdAt) })}</span>
              <span>{t('dashboard.campaign.updated', { ago: formatDurationShort(now - c.updatedAt) })}</span>
            </div>

            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="uppercase tracking-wide text-text-tertiary">{t('dashboard.campaign.milestones')}</span>
                <span className="text-text-secondary tabular-nums">{t('dashboard.campaign.green', { green, total: c.milestones.length })}</span>
              </div>
              <ul className="flex flex-col">
                {c.milestones.map((m, i) => (
                  <MilestoneRow key={m.id} m={m} isCurrent={i === c.currentMilestone && c.state === 'executing'} timeBoxMs={c.milestoneTimeBoxMs} now={now} />
                ))}
              </ul>
            </div>

            {c.currentTask && (
              <div className="text-xs" data-testid="current-task">
                <span className="uppercase tracking-wide text-text-tertiary">{t('dashboard.campaign.currentTask')}</span>
                <div className="mt-1 text-text">
                  <span className="font-mono">{c.currentTask.id}</span> · {c.currentTask.status} ·{' '}
                  {ACTIVE_TASK_STATES.has(c.currentTask.status)
                    ? t('dashboard.campaign.running', { elapsed: formatDurationShort(now - c.currentTask.createdAt) })
                    : t('dashboard.campaign.lasted', { elapsed: formatDurationShort(c.currentTask.updatedAt - c.currentTask.createdAt) })}
                </div>
                {c.currentTask.lastProgress && (
                  <div className="mt-0.5 text-text-secondary">
                    {t('dashboard.campaign.lastProgress', { age: formatDurationShort(now - (c.currentTask.lastProgressAt ?? c.currentTask.updatedAt)) })}: {c.currentTask.lastProgress}
                  </div>
                )}
              </div>
            )}
            {others.length > 0 && (
              <div className="text-xs">
                <span className="uppercase tracking-wide text-text-tertiary">{t('dashboard.campaign.otherTasks')} ({others.length})</span>
                <ul className="mt-1 flex flex-col gap-0.5 text-text-secondary">
                  {others.slice(0, 5).map((task) => (
                    <li key={task.id} className="truncate">
                      <span className="font-mono text-text">{task.id}</span> · {task.status} · {formatDurationShort(now - task.createdAt)}
                      {task.lastProgress ? ` — ${task.lastProgress}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {c.state === 'done' && (
                <span className={c.deliveryReported ? 'text-success' : 'text-warning'}>{c.deliveryReported ? t('dashboard.campaign.deliverySent') : t('dashboard.campaign.deliveryPending')}</span>
              )}
              {c.lastError && c.state !== 'executing' && <span className="text-error truncate max-w-full" title={c.lastError}>{t('dashboard.campaign.lastError')}: {c.lastError}</span>}
              {c.autoReviveAt !== undefined && <span className="text-text-secondary">{t('dashboard.campaign.autoRevive', { in: formatDurationShort(c.autoReviveAt - now) })}</span>}
              {c.revivable && <span className="text-accent">{t('dashboard.campaign.revivable')}</span>}
            </div>
          </div>
        )
      })()}

      {status?.guardian && (
        <div className="mt-4 pt-3 border-t border-white/5">
          <GuardianLine g={status.guardian} now={now} />
        </div>
      )}

      {status && (
        <div className="mt-4 pt-3 border-t border-white/5 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void measureNow()}
              disabled={measuring}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              {measuring ? t('dashboard.campaign.measuring') : t('dashboard.campaign.measure')}
            </button>
            <span className="text-[11px] text-text-tertiary">{t('dashboard.campaign.measureHint')}</span>
          </div>
          {measurementError && <p className="text-xs text-error">{t('dashboard.campaign.measureFailed', { error: measurementError })}</p>}
          {shownMeasurement && <MeasurementBlock m={shownMeasurement} />}
        </div>
      )}
    </section>
  )
}
