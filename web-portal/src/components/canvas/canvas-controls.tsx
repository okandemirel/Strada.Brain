import { useTranslation } from 'react-i18next'

interface CanvasControlsProps {
  zoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomFit: () => void
}

const btnCls = 'flex h-7 w-7 items-center justify-center rounded-lg border border-white/8 bg-transparent text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200'

export default function CanvasControls({ zoom, onZoomIn, onZoomOut, onZoomFit }: CanvasControlsProps) {
  const { t } = useTranslation('canvas')
  return (
    <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border border-white/8 bg-black/60 p-1 backdrop-blur-xl">
      <button type="button" className={btnCls} onClick={onZoomOut} title={t('controls.zoomOut')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14" /></svg>
      </button>
      <span className="min-w-[48px] text-center text-[10px] font-semibold text-slate-500">{Math.round(zoom * 100)}%</span>
      <button type="button" className={btnCls} onClick={onZoomIn} title={t('controls.zoomIn')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      <div className="mx-0.5 h-4 w-px bg-white/8" />
      <button type="button" className={btnCls} onClick={onZoomFit} title={t('controls.zoomToFit')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
      </button>
    </div>
  )
}
