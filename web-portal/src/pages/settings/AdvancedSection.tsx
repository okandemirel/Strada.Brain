import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useAutonomousStatus, useBootReport } from '../../hooks/use-api'
import { useWS } from '../../hooks/useWS'
import { resolveSettingsIdentity } from '../settings-identity'

const DURATION_OPTIONS = [
  { value: 1, label: '1h' },
  { value: 4, label: '4h' },
  { value: 8, label: '8h' },
  { value: 24, label: '24h' },
  { value: 48, label: '48h' },
  { value: 72, label: '72h' },
  { value: 168, label: '7d' },
]

const STAGE_STATUS_COLORS: Record<string, string> = {
  ok: 'bg-green-500/15 text-green-400',
  warn: 'bg-yellow-500/15 text-yellow-400',
  error: 'bg-red-500/15 text-red-400',
  skip: 'bg-white/5 text-text-tertiary',
}

const CAPABILITY_STATUS_COLORS: Record<string, string> = {
  enabled: 'bg-green-500/15 text-green-400',
  disabled: 'bg-white/5 text-text-secondary',
  partial: 'bg-yellow-500/15 text-yellow-400',
  error: 'bg-red-500/15 text-red-400',
}

export default function AdvancedSection() {
  const { t } = useTranslation('settings')
  const { sessionId, profileId } = useWS()
  const identity = resolveSettingsIdentity(sessionId, profileId)
  const { data: autonomousData } = useAutonomousStatus(identity?.query ?? null)
  const { data: bootData, isLoading: bootLoading } = useBootReport()
  const queryClient = useQueryClient()
  const [toggling, setToggling] = useState(false)
  const [durationHours, setDurationHours] = useState(24)

  const autonomousEnabled = autonomousData?.enabled ?? false
  const remainingMs = autonomousData?.remainingMs
  const bootReport = bootData?.bootReport

  const toggleAutonomous = useCallback(async () => {
    if (!identity) {
      toast.error(t('advanced.noActiveSession'))
      return
    }
    setToggling(true)
    try {
      const body = autonomousEnabled
        ? { enabled: false }
        : { enabled: true, durationHours }

      const res = await fetch(`/api/user/autonomous?${identity.query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error('Failed')
      toast.success(autonomousEnabled ? t('advanced.toastDisabled') : t('advanced.toastEnabled', { hours: durationHours }))
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['autonomous'] }), 500)
    } catch {
      toast.error(t('advanced.toastFailed'))
    } finally {
      setToggling(false)
    }
  }, [autonomousEnabled, durationHours, identity, queryClient])

  function formatRemaining(ms: number): string {
    const h = Math.floor(ms / 3_600_000)
    const m = Math.floor((ms % 3_600_000) / 60_000)
    if (h > 0) return t('advanced.remainingHours', { hours: h, minutes: m })
    return t('advanced.remainingMinutes', { minutes: m })
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-text mb-1">{t('advanced.title')}</h2>
      <p className="text-sm text-text-tertiary mb-6">{t('advanced.description')}</p>

      {/* Autonomous Mode */}
      <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
        {t('advanced.autonomousMode')}
      </p>
      <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-4">
        <div className="flex justify-between items-center mb-3">
          <div>
            <p className="text-sm font-medium text-text">{t('advanced.autonomousLabel')}</p>
            <p className="text-xs text-text-tertiary mt-0.5">
              {autonomousEnabled && remainingMs != null
                ? formatRemaining(remainingMs)
                : t('advanced.autonomousDescription')}
            </p>
          </div>
          <button
            onClick={toggleAutonomous}
            disabled={toggling || !identity}
            title={!identity ? t('advanced.openChatFirst') : undefined}
            className={`relative w-10 h-6 rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40 disabled:cursor-not-allowed ${autonomousEnabled ? 'bg-[var(--color-accent)]' : 'bg-white/10'}`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${autonomousEnabled ? 'translate-x-4' : 'translate-x-0'}`}
            />
          </button>
        </div>

        {/* Duration slider (only meaningful when not yet enabled) */}
        {!autonomousEnabled && (
          <div>
            <p className="text-xs text-text-tertiary mb-2">{t('advanced.durationWhenEnabling')}</p>
            <div className="flex gap-1.5 flex-wrap">
              {DURATION_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setDurationHours(opt.value)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${durationHours === opt.value ? 'bg-accent/20 text-accent border border-accent/30' : 'bg-white/5 text-text-secondary border border-white/5 hover:bg-white/8 hover:text-text'}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Boot Report */}
      {bootLoading && (
        <p className="text-sm text-text-tertiary animate-pulse mb-4">{t('advanced.loadingBootReport')}</p>
      )}

      {bootReport && (
        <>
          {/* Boot Stages */}
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
            {t('advanced.bootStages')}
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl mb-4 overflow-hidden">
            {bootReport.stages.map((stage, i) => (
              <div
                key={stage.id}
                className={`px-4 py-2.5 text-sm ${i < bootReport.stages.length - 1 ? 'border-b border-white/5' : ''}`}
              >
                <div className="flex justify-between items-center">
                  <span className="text-text font-medium">{stage.label}</span>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STAGE_STATUS_COLORS[stage.status] ?? 'bg-white/5 text-text-secondary'}`}>
                    {stage.status}
                  </span>
                </div>
                {stage.detail && (
                  <p className="text-text-tertiary text-xs mt-0.5 truncate">{stage.detail}</p>
                )}
              </div>
            ))}
          </div>

          {/* Capability Manifest */}
          {bootReport.capabilities.length > 0 && (
            <>
              <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
                {t('advanced.capabilities')}
              </p>
              <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl mb-4 overflow-hidden">
                {bootReport.capabilities.map((cap, i) => (
                  <div
                    key={cap.id}
                    className={`px-4 py-2.5 text-sm ${i < bootReport.capabilities.length - 1 ? 'border-b border-white/5' : ''}`}
                  >
                    <div className="flex justify-between items-center">
                      <div>
                        <span className="text-text font-medium">{cap.name}</span>
                        <span className="text-text-tertiary text-xs ml-2">{cap.tier}</span>
                      </div>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${CAPABILITY_STATUS_COLORS[cap.status] ?? 'bg-white/5 text-text-secondary'}`}>
                        {cap.status}
                      </span>
                    </div>
                    {cap.detail && (
                      <p className="text-text-tertiary text-xs mt-0.5">{cap.detail}</p>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* System Info */}
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
            {t('advanced.systemInfo')}
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl mb-4 overflow-hidden">
            <div className="flex justify-between items-center px-4 py-2.5 border-b border-white/5 text-sm">
              <span className="text-text-secondary">{t('advanced.recommendedPreset')}</span>
              <span className="text-text font-mono text-xs">{bootReport.goldenPath.recommendedPreset}</span>
            </div>
            <div className="flex justify-between items-center px-4 py-2.5 text-sm">
              <span className="text-text-secondary">{t('advanced.activeChannels')}</span>
              <span className="text-text font-mono text-xs">{bootReport.goldenPath.channels.join(', ')}</span>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
