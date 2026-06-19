import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useModelScores, type ModelWorkloadRankingEntry } from '../hooks/use-api'

/** The six task workloads models are grouped by (matches the backend). */
const WORKLOADS = ['planning', 'implementation', 'review', 'analysis', 'coordination', 'debugging'] as const
type Workload = (typeof WORKLOADS)[number]

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Drift badge: how far the blended score sits above/below the static baseline. */
function DriftBadge({ drift }: { drift: number }) {
  if (Math.abs(drift) < 0.005) {
    return <span className="text-[10px] text-text-tertiary">±0.00</span>
  }
  const up = drift > 0
  return (
    <span className={`text-[10px] font-mono ${up ? 'text-green-400' : 'text-red-400'}`}>
      {up ? '▲' : '▼'} {Math.abs(drift).toFixed(2)}
    </span>
  )
}

function LeaderboardRow({ entry, rank, isLast }: { entry: ModelWorkloadRankingEntry; rank: number; isLast: boolean }) {
  const label = entry.model ? `${entry.provider}/${entry.model}` : entry.provider
  const pct = Math.round(entry.score * 100)
  const confPct = Math.round(entry.confidence * 100)
  return (
    <div className={`px-4 py-2.5 ${isLast ? '' : 'border-b border-white/5'}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-text-tertiary text-xs font-mono w-4 shrink-0">{rank}</span>
          <span className="text-text font-medium text-sm truncate">{label}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <DriftBadge drift={entry.drift} />
          <span className="text-text font-mono text-xs w-8 text-right">{entry.score.toFixed(2)}</span>
        </div>
      </div>
      {/* Score bar; opacity encodes confidence so low-evidence rows read as faint. */}
      <div className="mt-1.5 h-1 rounded-full bg-white/5 overflow-hidden">
        <div
          className="h-full rounded-full bg-accent transition-all duration-300"
          style={{ width: `${pct}%`, opacity: 0.4 + 0.6 * entry.confidence }}
        />
      </div>
      <div className="flex gap-3 mt-1 text-[10px] text-text-tertiary">
        <span>{`obs ${entry.observationCount}`}</span>
        <span>{`confidence ${confPct}%`}</span>
      </div>
    </div>
  )
}

/**
 * Tier 2 dynamic model leaderboards — telemetry-blended per-model scores grouped
 * by task workload. Self-hides when the dynamic store is unavailable.
 */
export default function ModelScoresPanel() {
  const { t } = useTranslation('settings')
  const { data } = useModelScores()
  const [workload, setWorkload] = useState<Workload>('implementation')

  if (!data?.available) return null

  const rankings = data.workloads[workload] ?? []

  return (
    <>
      <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-1">
        {t('routing.modelLeaderboards')}
      </p>
      <p className="text-[11px] text-text-tertiary mb-3">{t('routing.modelLeaderboardsDesc')}</p>

      {/* Workload selector */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {WORKLOADS.map((w) => {
          const active = w === workload
          return (
            <button
              key={w}
              onClick={() => setWorkload(w)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all duration-150 ${active ? 'bg-accent/15 border border-accent/40 text-accent' : 'bg-white/3 border border-white/5 text-text-secondary hover:bg-white/5 hover:text-text'}`}
            >
              {capitalize(w)}
            </button>
          )
        })}
      </div>

      <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl mb-4 overflow-hidden">
        {rankings.length === 0 ? (
          <p className="text-xs text-text-tertiary text-center py-6">{t('routing.learningModels')}</p>
        ) : (
          rankings.map((entry, i) => (
            <LeaderboardRow key={entry.key} entry={entry} rank={i + 1} isLast={i === rankings.length - 1} />
          ))
        )}
      </div>
    </>
  )
}
