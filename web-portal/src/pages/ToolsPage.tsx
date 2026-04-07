import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
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
  dangerous?: boolean
  requiresConfirmation?: boolean
  category?: string
  dependencies?: string[]
  controlPlaneOnly?: boolean
}

function getTypeBadgeClass(type: string): string {
  switch (type) {
    case 'builtin':
      return 'bg-accent-glow text-accent'
    case 'chain':
      return 'bg-success/10 text-success'
    default:
      return 'bg-white/5 text-text-tertiary'
  }
}

function getErrorRateColorClass(rate: number): string {
  if (rate > 10) return 'text-error'
  if (rate > 0) return 'text-warning'
  return 'text-success'
}

function hasToolProperties(tool: ToolInfo): boolean {
  return !!(
    tool.dangerous ||
    tool.requiresConfirmation ||
    tool.requiresBridge ||
    tool.readOnly ||
    tool.controlPlaneOnly ||
    tool.available === false ||
    tool.paramCount != null ||
    (tool.dependencies && tool.dependencies.length > 0)
  )
}

interface ToolDetailPanelProps {
  tool: ToolInfo
  calls: number
  errors: number
  recentErrors: Array<{ message: string; timestamp: number }>
  onClose: () => void
  t: TFunction
}

function ToolDetailPanel({ tool, calls, errors, recentErrors, onClose, t }: ToolDetailPanelProps) {
  const errorRate = calls > 0 ? (errors / calls) * 100 : 0
  const errorRateLabel = errorRate.toFixed(1)

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg h-full overflow-y-auto bg-bg-secondary/95 backdrop-blur-xl border-l border-white/10 p-6 animate-[slide-in-right_0.2s_ease]"
        onClick={e => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-lg bg-white/5 border border-white/10 text-text-secondary hover:text-text hover:bg-white/10 transition-colors text-lg leading-none"
          aria-label={t('ui.close', 'Close')}
        >
          &times;
        </button>

        {/* Tool name */}
        <h3 className="text-xl font-bold font-mono text-text pr-10">{tool.name}</h3>

        {/* Badges row */}
        <div className="flex gap-2 mt-3 flex-wrap">
          {tool.type && (
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] ${getTypeBadgeClass(tool.type)}`}>
              {tool.type}
            </span>
          )}
          {tool.available === false ? (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] bg-warning/10 text-warning">
              {t('tools.badgeUnavailable')}
            </span>
          ) : (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] bg-success/10 text-success">
              {t('tools.badgeAvailable', 'available')}
            </span>
          )}
          {tool.readOnly === true && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] bg-white/5 text-text-tertiary">{t('tools.badgeReadOnly')}</span>
          )}
          {tool.requiresBridge && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] bg-white/5 text-text-tertiary">{t('tools.badgeBridge')}</span>
          )}
          {tool.dangerous && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] bg-error/10 text-error">
              {t('tools.badgeDangerous', 'dangerous')}
            </span>
          )}
          {tool.category && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] bg-white/5 text-text-tertiary">
              {tool.category}
            </span>
          )}
        </div>

        {/* Description */}
        {tool.description && (
          <p className="mt-4 text-sm text-text-secondary leading-relaxed">{tool.description}</p>
        )}

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-3 mt-6">
          <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3 text-center">
            <div className="text-2xl font-bold text-text">{calls}</div>
            <div className="text-[10px] uppercase tracking-wide text-text-tertiary mt-1">{t('tools.statCalls', 'Calls')}</div>
          </div>
          <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3 text-center">
            <div className={`text-2xl font-bold ${errors > 0 ? 'text-error' : 'text-success'}`}>{errors}</div>
            <div className="text-[10px] uppercase tracking-wide text-text-tertiary mt-1">{t('tools.statErrors', 'Errors')}</div>
          </div>
          <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3 text-center">
            <div className={`text-2xl font-bold ${getErrorRateColorClass(errorRate)}`}>{errorRateLabel}%</div>
            <div className="text-[10px] uppercase tracking-wide text-text-tertiary mt-1">{t('tools.statErrorRate', 'Error Rate')}</div>
          </div>
        </div>

        {/* Recent Errors section */}
        <div className="mt-6">
          <h4 className="text-sm font-semibold text-text mb-3">{t('tools.recentErrors', 'Recent Errors')}</h4>
          {recentErrors.length === 0 ? (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-400">
              {t('tools.noErrors', 'No errors recorded')}
            </div>
          ) : (
            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              {recentErrors.slice().reverse().map((err, i) => (
                <div key={i} className="rounded-xl border border-error/15 bg-error/5 px-3 py-2.5">
                  <div className="text-[10px] text-text-tertiary mb-1">
                    {new Date(err.timestamp).toLocaleString()}
                  </div>
                  <div className="text-xs text-error/90 font-mono break-all leading-relaxed">
                    {err.message}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Tool properties */}
        <div className="mt-6">
          <h4 className="text-sm font-semibold text-text mb-3">{t('tools.properties', 'Properties')}</h4>
          <div className="space-y-2 text-xs">
            {tool.dangerous && (
              <div className="text-warning">{t('tools.propDangerous', 'Dangerous -- requires confirmation')}</div>
            )}
            {tool.requiresConfirmation && !tool.dangerous && (
              <div className="text-warning">{t('tools.propRequiresConfirmation', 'Requires confirmation before execution')}</div>
            )}
            {tool.requiresBridge && (
              <div className="text-text-secondary">{t('tools.propRequiresBridge', 'Requires Unity Bridge connection')}</div>
            )}
            {tool.readOnly && (
              <div className="text-text-secondary">{t('tools.propReadOnly', 'Read-only (no side effects)')}</div>
            )}
            {tool.controlPlaneOnly && (
              <div className="text-text-secondary">{t('tools.propControlPlane', 'Control plane only')}</div>
            )}
            {tool.available === false && (
              <div className="text-warning">{tool.availabilityReason || t('tools.propUnavailable', 'Currently unavailable')}</div>
            )}
            {tool.paramCount != null && (
              <div className="text-text-secondary">{t('tools.propParams', 'Parameters')}: {tool.paramCount}</div>
            )}
            {tool.dependencies && tool.dependencies.length > 0 && (
              <div className="text-text-secondary">
                {t('tools.propDependencies', 'Dependencies')}: {tool.dependencies.join(', ')}
              </div>
            )}
            {!hasToolProperties(tool) && (
              <div className="text-text-tertiary">{t('tools.noProperties', 'No special properties')}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ToolsPage() {
  const { t } = useTranslation('pages')
  const toolsQuery = useTools()
  const metricsQuery = useMetrics()
  const [filter, setFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [selectedTool, setSelectedTool] = useState<string | null>(null)

  const error = toolsQuery.error && metricsQuery.error
    ? toolsQuery.error.message
    : null
  const loading = toolsQuery.isLoading && metricsQuery.isLoading

  if (error) return <PageError title={t('tools.errorTitle')} message={error} />
  if (loading) return <PageSkeleton />

  let tools: ToolInfo[] = toolsQuery.data?.tools ?? []
  const callCounts: Record<string, number> =
    toolsQuery.data?.callCounts ??
    (metricsQuery.data?.toolCallCounts as Record<string, number>) ?? {}
  const errorCounts: Record<string, number> =
    toolsQuery.data?.errorCounts ??
    (metricsQuery.data?.toolErrorCounts as Record<string, number>) ?? {}
  const recentErrors: Record<string, Array<{ message: string; timestamp: number }>> =
    toolsQuery.data?.recentErrors ?? {}

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
            <div
              key={tool.name}
              className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-4 transition-all duration-200 hover:border-border-hover hover:-translate-y-px hover:shadow-[var(--shadow-sm)] cursor-pointer"
              onClick={() => setSelectedTool(tool.name)}
              role="button"
              tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setSelectedTool(tool.name) }}
            >
              <div className="text-sm font-semibold text-text font-mono mb-1.5">{tool.name}</div>
              {tool.description && (
                <div className="text-xs text-text-secondary leading-snug line-clamp-2">{tool.description}</div>
              )}
              <div className="flex gap-2 mt-2.5 flex-wrap">
                {tool.type && (
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] ${getTypeBadgeClass(tool.type)}`}>
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

      {selectedTool && (() => {
        const tool = tools.find(t => t.name === selectedTool)
        if (!tool) return null
        return (
          <ToolDetailPanel
            tool={tool}
            calls={callCounts[tool.name] ?? 0}
            errors={errorCounts[tool.name] ?? 0}
            recentErrors={recentErrors[tool.name] ?? []}
            onClose={() => setSelectedTool(null)}
            t={t}
          />
        )
      })()}
    </div>
  )
}
