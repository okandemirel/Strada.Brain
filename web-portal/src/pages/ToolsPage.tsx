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

  if (error) return <div className="page-error">Error: {error}</div>
  if (loading) return <div className="page-loading">Loading tools...</div>

  // Derive tool list
  let tools: ToolInfo[] = toolsQuery.data?.tools ?? []
  const callCounts: Record<string, number> = (metricsQuery.data?.toolCallCounts as Record<string, number>) ?? {}
  const errorCounts: Record<string, number> = (metricsQuery.data?.toolErrorCounts as Record<string, number>) ?? {}

  // If no tools endpoint, synthesize from metrics
  if (tools.length === 0 && metricsQuery.data?.toolCallCounts) {
    tools = Object.keys(metricsQuery.data.toolCallCounts).map(name => ({
      name,
      description: '',
      type: 'builtin' as const,
    }))
  }

  if (tools.length === 0) {
    return (
      <div className="admin-page">
        <h2>Tools</h2>
        <div className="page-empty">
          <h3>No Tools Available</h3>
          <p>Tool data is not available. Make sure the server is running.</p>
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
    <div className="admin-page">
      <h2>Tools ({tools.length})</h2>
      <input
        className="admin-search"
        type="text"
        placeholder="Search tools..."
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />
      <div className="admin-filter-bar">
        {types.map(type => (
          <button
            key={type}
            className={`admin-filter-btn ${typeFilter === type ? 'active' : ''}`}
            onClick={() => setTypeFilter(type)}
          >
            {type === 'all' ? 'All' : type}
          </button>
        ))}
      </div>
      <div className="tool-grid">
        {filtered.map(tool => {
          const calls = callCounts[tool.name] ?? 0
          const errors = errorCounts[tool.name] ?? 0
          return (
            <div key={tool.name} className="tool-card">
              <div className="tool-card-name">{tool.name}</div>
              {tool.description && (
                <div className="tool-card-desc">{tool.description}</div>
              )}
              <div className="tool-card-meta">
                {tool.type && (
                  <span className={`tool-tag ${tool.type === 'builtin' ? 'builtin' : tool.type === 'chain' ? 'chain' : ''}`}>
                    {tool.type}
                  </span>
                )}
                {tool.available === false && (
                  <span className="tool-tag" style={{ background: 'rgba(255, 159, 10, 0.12)', color: 'var(--warning, #ff9f0a)' }}>
                    unavailable
                  </span>
                )}
                {tool.requiresBridge && (
                  <span className="tool-tag">bridge</span>
                )}
                {tool.readOnly === true && (
                  <span className="tool-tag">read-only</span>
                )}
                {calls > 0 && (
                  <span className="tool-tag">{calls} calls</span>
                )}
                {errors > 0 && (
                  <span className="tool-tag" style={{ background: 'rgba(255, 69, 58, 0.12)', color: 'var(--error)' }}>
                    {errors} errors
                  </span>
                )}
              </div>
              {tool.available === false && tool.availabilityReason && (
                <div className="tool-card-desc">{tool.availabilityReason}</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
