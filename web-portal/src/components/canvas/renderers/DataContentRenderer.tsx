import type { RendererProps } from '../card-registry'

export default function DataContentRenderer({ type, props }: RendererProps) {
  if (type === 'metric-card') {
    const value = String(props.value ?? '—')
    const label = String(props.label ?? props.title ?? '')
    const trend = String(props.trend ?? '')
    return (
      <div className="flex flex-col items-center justify-center py-1">
        <div className="text-2xl font-bold text-text">{value}</div>
        {label && <div className="text-[10px] text-text-tertiary mt-0.5">{label}</div>}
        {trend && <div className="text-[10px] text-accent/70">{trend}</div>}
      </div>
    )
  }
  const label = String(props.label ?? props.title ?? props.name ?? '')
  const status = String(props.status ?? '')
  return (
    <div className="flex items-center gap-2">
      {status && <span className={`w-2 h-2 rounded-full shrink-0 ${status === 'active' ? 'bg-emerald-400' : 'bg-white/20'}`} />}
      <div className="text-xs text-text truncate">{label || 'Node'}</div>
    </div>
  )
}
