import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useAgentActivity } from '../../hooks/use-api'
import { useWS } from '../../hooks/useWS'
import { resolveSettingsIdentity } from '../settings-identity'

const PRESETS = [
  { id: 'budget', labelKey: 'routing.presetBudget', descKey: 'routing.presetBudgetDesc' },
  { id: 'balanced', labelKey: 'routing.presetBalanced', descKey: 'routing.presetBalancedDesc' },
  { id: 'performance', labelKey: 'routing.presetPerformance', descKey: 'routing.presetPerformanceDesc' },
] as const

type PresetId = (typeof PRESETS)[number]['id']

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}

export default function RoutingSection() {
  const { t } = useTranslation('settings')
  const { sessionId, profileId } = useWS()
  const identity = resolveSettingsIdentity(sessionId, profileId)
  const { data: activity } = useAgentActivity(identity?.query ?? null)
  const [applyingPreset, setApplyingPreset] = useState<PresetId | null>(null)

  const activePreset = activity?.preset as PresetId | undefined

  const applyPreset = useCallback(async (preset: PresetId) => {
    setApplyingPreset(preset)
    try {
      const res = await fetch('/api/routing/preset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset }),
      })
      if (!res.ok) throw new Error('Failed')
      toast.success(t('routing.toastPresetSet', { preset }))
    } catch {
      toast.error(t('routing.toastPresetFailed'))
    } finally {
      setApplyingPreset(null)
    }
  }, [])

  const routing = activity?.routing?.slice(0, 6) ?? []
  const execution = activity?.execution?.slice(0, 6) ?? []
  const outcomes = activity?.outcomes?.slice(0, 6) ?? []
  const phaseScores = activity?.phaseScores ?? []

  return (
    <div>
      <h2 className="text-lg font-semibold text-text mb-1">{t('routing.title')}</h2>
      <p className="text-sm text-text-tertiary mb-6">{t('routing.description')}</p>

      {/* Preset Selector */}
      <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
        {t('routing.routingPreset')}
      </p>
      <div className="grid grid-cols-3 gap-2 mb-6">
        {PRESETS.map((p) => {
          const isActive = activePreset === p.id
          const isApplying = applyingPreset === p.id
          return (
            <button
              key={p.id}
              onClick={() => applyPreset(p.id)}
              disabled={isApplying}
              className={`px-3 py-3 rounded-xl border text-left transition-all duration-150 disabled:opacity-50 ${isActive ? 'bg-accent/15 border-accent/40 text-accent' : 'bg-white/3 backdrop-blur border-white/5 text-text-secondary hover:bg-white/5 hover:text-text hover:border-white/10'}`}
            >
              <p className="text-xs font-semibold">{isApplying ? '...' : t(p.labelKey)}</p>
              <p className="text-[10px] mt-0.5 opacity-70">{t(p.descKey)}</p>
            </button>
          )
        })}
      </div>

      {/* Recent Routing Decisions */}
      {routing.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
            {t('routing.recentRoutingDecisions')}
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl mb-4 overflow-hidden">
            {routing.map((r, i) => (
              <div
                key={`${r.provider}-${r.timestamp}`}
                className={`px-4 py-2.5 text-sm ${i < routing.length - 1 ? 'border-b border-white/5' : ''}`}
              >
                <div className="flex justify-between items-center">
                  <span className="text-text font-medium">{r.provider}</span>
                  <span className="text-text-tertiary text-xs">{timeAgo(r.timestamp)}</span>
                </div>
                <p className="text-text-secondary text-xs mt-0.5 truncate">{r.reason}</p>
                <div className="flex gap-2 mt-1">
                  <span className="text-[10px] text-text-tertiary">{r.task.type}</span>
                  <span className="text-[10px] text-text-tertiary">{r.task.complexity}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Recent Execution Traces */}
      {execution.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
            {t('routing.recentExecutionTraces')}
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl mb-4 overflow-hidden">
            {execution.map((e, i) => (
              <div
                key={`${e.provider}-${e.phase}-${e.timestamp}`}
                className={`px-4 py-2.5 text-sm ${i < execution.length - 1 ? 'border-b border-white/5' : ''}`}
              >
                <div className="flex justify-between items-center">
                  <span className="text-text font-medium">{`${e.provider}${e.model ? `/${e.model}` : ''}`}</span>
                  <span className="text-text-tertiary text-xs">{timeAgo(e.timestamp)}</span>
                </div>
                <div className="flex gap-2 mt-0.5">
                  <span className="text-[10px] text-text-secondary">{e.phase}</span>
                  <span className="text-[10px] text-text-tertiary">{e.role}</span>
                  <span className="text-[10px] text-text-tertiary">{e.source}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Phase Outcomes */}
      {outcomes.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
            {t('routing.phaseOutcomes')}
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl mb-4 overflow-hidden">
            {outcomes.map((o, i) => (
              <div
                key={`${o.provider}-${o.phase}-${o.timestamp}`}
                className={`px-4 py-2.5 text-sm ${i < outcomes.length - 1 ? 'border-b border-white/5' : ''}`}
              >
                <div className="flex justify-between items-center">
                  <span className="text-text font-medium">{`${o.provider} — ${o.phase}`}</span>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${o.status === 'approved' ? 'bg-green-500/15 text-green-400' : o.status === 'failed' ? 'bg-red-500/15 text-red-400' : 'bg-white/5 text-text-secondary'}`}>
                    {o.status}
                  </span>
                </div>
                <p className="text-text-tertiary text-xs mt-0.5 truncate">{o.reason}</p>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Adaptive Phase Scores */}
      {phaseScores.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
            {t('routing.adaptivePhaseScores')}
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl mb-4 overflow-hidden">
            {phaseScores.map((s, i) => (
              <div
                key={`${s.provider}-${s.phase}`}
                className={`px-4 py-2.5 text-sm ${i < phaseScores.length - 1 ? 'border-b border-white/5' : ''}`}
              >
                <div className="flex justify-between items-center">
                  <div>
                    <span className="text-text font-medium">{s.phase}</span>
                    <span className="text-text-tertiary text-xs ml-2">{s.provider}</span>
                  </div>
                  <span className="text-text font-mono text-xs">{s.score.toFixed(2)}</span>
                </div>
                <div className="flex gap-3 mt-0.5 text-[10px] text-text-tertiary">
                  <span>{`n=${s.sampleSize}`}</span>
                  <span>{`approved=${s.approvedCount}`}</span>
                  <span>{`failed=${s.failedCount}`}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {routing.length === 0 && execution.length === 0 && outcomes.length === 0 && phaseScores.length === 0 && (
        <p className="text-sm text-text-tertiary text-center py-8">{t('routing.noActivity')}</p>
      )}
    </div>
  )
}
