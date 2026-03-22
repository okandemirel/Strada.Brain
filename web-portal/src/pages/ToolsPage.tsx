import { useState } from 'react'
import { useTools, useMetrics } from '../hooks/use-api'

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
  const toolsQuery = useTools()
  const metricsQuery = useMetrics()
  const [filter, setFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')

  const error = toolsQuery.error && metricsQuery.error
    ? toolsQuery.error.message
    : null
  const loading = toolsQuery.isLoading && metricsQuery.isLoading

  if (error) return <div className="flex flex-1 items-center justify-center h-[200px] text-error text-[15px]">Error: {error}</div>
  if (loading) return <div className="flex flex-1 items-center justify-center h-[200px] text-text-secondary text-[15px]">Loading tools...</div>

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
      <div className="flex-1 overflow-y-auto p-7 w-full animate-[admin-fade-in_0.3s_ease]">
        <h2 className="text-[22px] font-bold tracking-tight mb-6 text-text">Tools</h2>
        <div className="flex flex-col items-center justify-center h-[200px] gap-2.5 text-text-secondary text-center">
          <h3 className="text-text text-lg font-semibold">No Tools Available</h3>
          <p className="text-sm max-w-[400px]">Tool data is not available. Make sure the server is running.</p>
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
    <div className="flex-1 overflow-y-auto p-7 w-full animate-[admin-fade-in_0.3s_ease]">
      <h2 className="text-[22px] font-bold tracking-tight mb-6 text-text">Tools ({tools.length})</h2>
      <input
        className="w-full max-w-[400px] px-4 py-2.5 border border-border rounded-xl bg-input-bg text-text font-[inherit] text-sm outline-none transition-all duration-200 mb-5 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-glow)] placeholder:text-text-tertiary"
        type="text"
        placeholder="Search tools..."
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
                : 'border-border bg-bg-tertiary text-text-secondary hover:bg-bg-elevated hover:text-text hover:border-border-hover'
            }`}
            onClick={() => setTypeFilter(type)}
          >
            {type === 'all' ? 'All' : type}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {filtered.map(tool => {
          const calls = callCounts[tool.name] ?? 0
          const errors = errorCounts[tool.name] ?? 0
          return (
            <div key={tool.name} className="bg-bg-secondary border border-border rounded-[14px] p-4 transition-all duration-200 hover:border-border-hover hover:-translate-y-px hover:shadow-[var(--shadow-sm)]">
              <div className="text-sm font-semibold text-text font-mono mb-1.5">{tool.name}</div>
              {tool.description && (
                <div className="text-xs text-text-secondary leading-snug line-clamp-2">{tool.description}</div>
              )}
              <div className="flex gap-2 mt-2.5 flex-wrap">
                {tool.type && (
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] ${
                    tool.type === 'builtin' ? 'bg-accent-glow text-accent' : tool.type === 'chain' ? 'bg-success/10 text-success' : 'bg-bg-tertiary text-text-tertiary'
                  }`}>
                    {tool.type}
                  </span>
                )}
                {tool.available === false && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] bg-warning/10 text-warning">
                    unavailable
                  </span>
                )}
                {tool.requiresBridge && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] bg-bg-tertiary text-text-tertiary">bridge</span>
                )}
                {tool.readOnly === true && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] bg-bg-tertiary text-text-tertiary">read-only</span>
                )}
                {calls > 0 && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] bg-bg-tertiary text-text-tertiary">{calls} calls</span>
                )}
                {errors > 0 && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] bg-error/10 text-error">
                    {errors} errors
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
