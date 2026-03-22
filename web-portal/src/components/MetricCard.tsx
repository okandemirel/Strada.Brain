export interface MetricCardProps {
  title: string
  value: string | number
  subtitle?: string
  trend?: 'up' | 'down' | 'neutral'
  icon?: string
}

const TREND_CONFIG: Record<string, { arrow: string; className: string }> = {
  up: { arrow: '+', className: 'text-success' },
  down: { arrow: '-', className: 'text-error' },
}

export default function MetricCard({ title, value, subtitle, trend, icon }: MetricCardProps) {
  const trendInfo = trend ? TREND_CONFIG[trend] : undefined

  return (
    <div className="bg-bg-secondary backdrop-blur-[20px] border border-border rounded-2xl p-[18px] flex flex-col gap-2.5 transition-all duration-200 hover:border-border-hover hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]">
      <div className="flex items-center gap-2">
        {icon && (
          <span className="flex items-center justify-center w-6 h-6 rounded-md bg-accent-glow text-[11px] font-bold text-accent">
            {icon}
          </span>
        )}
        <span className="text-xs text-text-tertiary font-medium uppercase tracking-[0.02em]">{title}</span>
      </div>
      <div className="text-[28px] font-bold text-text flex items-baseline gap-1.5 tracking-tight">
        {value}
        {trendInfo && (
          <span className={`text-[13px] font-semibold ${trendInfo.className}`}>
            {trendInfo.arrow}
          </span>
        )}
      </div>
      {subtitle && <div className="text-xs text-text-tertiary">{subtitle}</div>}
    </div>
  )
}
