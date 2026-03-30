import { useTranslation } from 'react-i18next'
import { useMonitorStore } from '../../stores/monitor-store'

interface CanvasEmptyStateProps {
  onVisualize: () => void
}

export default function CanvasEmptyState({ onVisualize }: CanvasEmptyStateProps) {
  const { t } = useTranslation('canvas')
  const activeRootId = useMonitorStore(s => s.activeRootId)
  const tasks = useMonitorStore(s => s.tasks)

  const activeTasks = activeRootId
    ? Object.values(tasks).filter(t => t.rootId === activeRootId)
    : []
  const hasAgentContext = activeTasks.length > 0

  const executingCount = activeTasks.filter(t => t.status === 'executing').length
  const completedCount = activeTasks.filter(t => t.status === 'completed').length

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center" data-canvas-bg data-testid="canvas-empty-state">
      {/* Dot grid background */}
      <div
        className="absolute inset-0 pointer-events-none opacity-20"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.15) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}
      />

      {/* Subtle radial glow */}
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,rgba(125,211,252,0.04),transparent_50%)]" />

      <div className="relative z-10 flex flex-col items-center gap-6 max-w-md text-center px-6">
        {hasAgentContext ? (
          <div className="rounded-2xl border border-sky-400/15 bg-sky-400/[0.06] px-6 py-5 backdrop-blur-xl w-full">
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-sky-400/70">{t('empty.agentActivity')}</div>
            <div className="mt-3 text-lg font-semibold text-white">
              {t('empty.tasksInProgress', { count: activeTasks.length })}
            </div>
            <div className="mt-2 flex justify-center gap-4 text-xs">
              {executingCount > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
                  <span className="text-emerald-300">{t('empty.running', { count: executingCount })}</span>
                </span>
              )}
              {completedCount > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                  <span className="text-sky-300">{t('empty.done', { count: completedCount })}</span>
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={onVisualize}
              className="mt-4 inline-flex items-center gap-2 rounded-full border border-sky-400/20 bg-sky-400/10 px-5 py-2 text-sm font-semibold text-sky-300 transition-all hover:bg-sky-400/15 hover:border-sky-400/30 hover:shadow-[0_0_20px_rgba(14,165,233,0.15)]"
              data-testid="canvas-visualize-btn"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M8 12l2 2 4-4" /></svg>
              {t('empty.visualizeOnCanvas')}
            </button>
          </div>
        ) : (
          <>
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/8 bg-white/[0.03]">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgba(148,163,184,0.4)" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="4" />
                <path d="M12 8v8M8 12h8" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-medium text-slate-400">{t('empty.spatialCanvas')}</div>
              <div className="mt-1.5 text-xs text-slate-600 leading-relaxed">
                {t('empty.agentVisualsDescription')}
                <br />
                {t('empty.blankCanvasDescription')}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
