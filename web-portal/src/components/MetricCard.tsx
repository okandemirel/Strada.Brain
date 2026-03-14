export interface MetricCardProps {
  title: string
  value: string | number
  subtitle?: string
  trend?: 'up' | 'down' | 'neutral'
  icon?: string
}

const TREND_CONFIG: Record<string, { arrow: string; className: string }> = {
  up: { arrow: '+', className: 'trend-up' },
  down: { arrow: '-', className: 'trend-down' },
}

export default function MetricCard({ title, value, subtitle, trend, icon }: MetricCardProps) {
  const trendInfo = trend ? TREND_CONFIG[trend] : undefined

  return (
    <div className="metric-card">
      <div className="metric-card-header">
        {icon && <span className="metric-card-icon">{icon}</span>}
        <span className="metric-card-title">{title}</span>
      </div>
      <div className="metric-value">
        {value}
        {trendInfo && (
          <span className={`metric-trend ${trendInfo.className}`}>
            {trendInfo.arrow}
          </span>
        )}
      </div>
      {subtitle && <div className="metric-subtitle">{subtitle}</div>}
    </div>
  )
}
