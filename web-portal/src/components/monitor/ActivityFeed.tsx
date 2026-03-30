import { useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useMonitorStore } from '../../stores/monitor-store'
import { normalizeLabel } from './monitor-utils'

export default function ActivityFeed() {
  const { t } = useTranslation('monitor')
  const activities = useMonitorStore((s) => s.activities)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activities.length])

  if (activities.length === 0) {
    return (
      <div className="p-4">
        <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-5">
          <div className="text-sm text-text-tertiary">{t('activity.empty')}</div>
          <div className="mt-2 text-xs leading-5 text-text-secondary">
            {t('activity.emptyDescription')}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto px-3 pb-3 pt-1 text-xs">
      <div className="sticky top-0 z-[1] mb-3 flex items-center justify-between rounded-xl border border-white/6 bg-bg/80 px-3 py-2 backdrop-blur">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">
            {t('activity.timelineLabel')}
          </div>
          <div className="mt-1 text-xs text-text-secondary">
            {t('activity.eventsCaptured', { count: activities.length })}
          </div>
        </div>
        <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
          {t('activity.liveIndicator')}
        </span>
      </div>

      <div className="relative ml-2 border-l border-white/8">
        {activities.map((entry, index) => (
          <div key={`${entry.timestamp}-${index}`} className="relative pl-5">
            <span className="absolute -left-[5px] top-6 h-2.5 w-2.5 rounded-full border border-accent/30 bg-accent shadow-[0_0_10px_rgba(0,229,255,0.4)]" />
            <div className="mb-2 rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-3 shadow-[0_16px_34px_rgba(0,0,0,0.12)]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                  {normalizeLabel(entry.action)}
                </span>
                {entry.tool && (
                  <span className="rounded-full border border-accent/10 bg-accent/10 px-2 py-0.5 font-mono text-[10px] text-accent">
                    {entry.tool}
                  </span>
                )}
                {entry.taskId && (
                  <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[10px] text-text-secondary">
                    {entry.taskId}
                  </span>
                )}
              </div>
              <div className="mt-2 text-sm leading-5 text-text-secondary">{entry.detail}</div>
            </div>
          </div>
        ))}
      </div>

      <div ref={bottomRef} />
    </div>
  )
}
