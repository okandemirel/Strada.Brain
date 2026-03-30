import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTools, useMetrics } from '../hooks/use-api'
import { PageSkeleton } from '../components/ui/page-skeleton'
import { PageError } from '../components/ui/page-error'

interface ToolInfo {
  name: string
  description: string
  type: 'builtin' | 'chain' | 'composite' | 'delegation' | string
  installed?: boolean
  available?: boolean
  requiresBridge?: boolean
  readOnly?: boolean
  availabilityReason?: string
  paramCount?: number
}

export default function ToolsPage() {
  const { t } = useTranslation('pages')
  const toolsQuery = useTools()
  const metricsQuery = useMetrics()
  const [filter, setFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')

  const error = toolsQuery.error && metricsQuery.error
    ? toolsQuery.error.message
    : null
  const loading = toolsQuery.isLoading && metricsQuery.isLoading

  if (error) return <PageError title={t('tools.errorTitle')} message={error} />
  if (loading) return <PageSkeleton />

  let tools: ToolInfo[] = toolsQuery.data?.tools ?? []
  const callCounts: Record<string, number> = (metricsQuery.data?.toolCallCounts as Record<string, number>) ?? {}
  const errorCounts: Record<string, number> = (metricsQuery.data?.toolErrorCounts as Record<string, number>) ?? {}

  if (tools.length === 0 && metricsQuery.data?.toolCallCounts) {
    tools = Object.keys(metricsQuery.data.toolCallCounts).map(name => ({
      name,
      description: '',
      type: 'builtin' as const,
    }))
  }

  if (tools.length === 0) {
    return (
      <div className="h-full overflow-y-auto p-7 w-full animate-[admin-fade-in_0.3s_ease]">
        <h2 className="text-[22px] font-bold tracking-tight mb-6 text-text">{t('tools.title')}</h2>
        <div className="flex flex-col items-center justify-center h-[200px] gap-2.5 text-text-secondary text-center">
          <h3 className="text-text text-lg font-semibold">{t('tools.noToolsTitle')}</h3>
          <p className="text-sm max-w-[400px]">{t('tools.noToolsDescription')}</p>
        </div>
      </div>
    )
  }

  const types = ['all', ...new Set(tools.map(t => t.type).filter(Boolean))]

  const filtered = tools.filter(t => {
    const matchesName = t.name.toLowerCase().includes(filter.toLowerCase()) ||
      t.description.toLowerCase().includes(filter.toLowerCase())
    const matchesType = typeFilter === 'all' || t.type === typeFilter
    return matchesName && matchesType
  })

  return (
    <div className="h-full overflow-y-auto p-7 w-full animate-[admin-fade-in_0.3s_ease]">
      <h2 className="text-[22px] font-bold tracking-tight mb-6 text-text">{t('tools.titleWithCount', { count: tools.length })}</h2>
      <input
        className="w-full max-w-[400px] px-4 py-2.5 border border-border rounded-xl bg-input-bg text-text font-[inherit] text-sm outline-none transition-all duration-200 mb-5 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-glow)] placeholder:text-text-tertiary"
        type="text"
        placeholder={t('tools.searchPlaceholder')}
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />
      <div className="flex gap-2 mb-5 flex-wrap items-center">
        {types.map(type => (
          <button
            key={type}
            className={`px-3.5 py-1.5 border rounded-lg font-[inherit] text-[13px] font-medium cursor-pointer transition-all duration-150 ${
              typeFilter === type
                ? 'bg-accent-glow text-accent border-accent font-semibold'
                : 'border-white/5 bg-white/5 text-text-secondary hover:bg-white/10 hover:text-text hover:border-border-hover'
            }`}
            onClick={() => setTypeFilter(type)}
          >
            {type === 'all' ? t('tools.filterAll') : type}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {filtered.map(tool => {
          const calls = callCounts[tool.name] ?? 0
          const errors = errorCounts[tool.name] ?? 0
          return (
            <div key={tool.name} className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-4 transition-all duration-200 hover:border-border-hover hover:-translate-y-px hover:shadow-[var(--shadow-sm)]">
              <div className="text-sm font-semibold text-text font-mono mb-1.5">{tool.name}</div>
              {tool.description && (
                <div className="text-xs text-text-secondary leading-snug line-clamp-2">{tool.description}</div>
              )}
              <div className="flex gap-2 mt-2.5 flex-wrap">
                {tool.type && (
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] ${
                    tool.type === 'builtin' ? 'bg-accent-glow text-accent' : tool.type === 'chain' ? 'bg-success/10 text-success' : 'bg-white/5 text-text-tertiary'
                  }`}>
                    {tool.type}
                  </span>
                )}
                {tool.available === false && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] bg-warning/10 text-warning">
                    {t('tools.badgeUnavailable')}
                  </span>
                )}
                {tool.requiresBridge && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] bg-white/5 text-text-tertiary">{t('tools.badgeBridge')}</span>
                )}
                {tool.readOnly === true && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] bg-white/5 text-text-tertiary">{t('tools.badgeReadOnly')}</span>
                )}
                {calls > 0 && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] bg-white/5 text-text-tertiary">{t('tools.callCount', { count: calls })}</span>
                )}
                {errors > 0 && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] bg-error/10 text-error">
                    {t('tools.errorCount', { count: errors })}
                  </span>
                )}
              </div>
              {tool.available === false && tool.availabilityReason && (
                <div className="text-xs text-text-secondary leading-snug mt-2">{tool.availabilityReason}</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
