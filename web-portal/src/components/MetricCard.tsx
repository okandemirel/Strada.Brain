import { cn } from '@/lib/utils'
import { NumberTicker } from './ui/number-ticker'
import { BorderBeam } from './ui/border-beam'

export interface MetricCardProps {
  title: string
  value: string | number
  subtitle?: string
  trend?: 'up' | 'down' | 'neutral'
  icon?: string
  status?: 'default' | 'success' | 'warning' | 'error'
}

const TREND_CONFIG: Record<string, { arrow: string; label: string; className: string }> = {
  up:   { arrow: '▲', label: 'up',   className: 'text-success' },
  down: { arrow: '▼', label: 'down', className: 'text-error' },
}

const STATUS_ACCENT: Record<string, string> = {
  default: 'border-l-accent',
  success: 'border-l-success',
  warning: 'border-l-warning',
  error:   'border-l-error',
}

export default function MetricCard({ title, value, subtitle, trend, icon, status = 'default' }: MetricCardProps) {
  const trendInfo = trend && trend !== 'neutral' ? TREND_CONFIG[trend] : undefined
  const accentClass = STATUS_ACCENT[status] ?? STATUS_ACCENT.default

  return (
    <div
      className={cn(
        'relative overflow-hidden',
        'bg-white/3 backdrop-blur-xl border border-white/8 border-l-[3px] rounded-2xl p-4',
        'flex flex-col gap-2',
        'transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_0_20px_rgba(0,229,255,0.15)]',
        accentClass,
      )}
    >
      {status === 'success' && <BorderBeam size={100} duration={8} />}
      <div className="flex items-center gap-2">
        {icon && (
          <span className="flex items-center justify-center w-6 h-6 rounded-md bg-accent-glow text-[11px] font-bold text-accent">
            {icon}
          </span>
        )}
        <span className="text-xs text-text-secondary font-medium uppercase tracking-wide">{title}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xl font-bold text-text animate-[count-up_0.4s_ease]">
          {typeof value === 'number' ? (
            <NumberTicker value={value} className="text-2xl font-bold text-text" />
          ) : (
            <span>{value}</span>
          )}
        </span>
        {trendInfo && (
          <span className={cn('text-[13px] font-semibold', trendInfo.className)}>
            {trendInfo.arrow}
          </span>
        )}
      </div>
      {subtitle && <div className="text-xs text-text-secondary">{subtitle}</div>}
    </div>
  )
}
