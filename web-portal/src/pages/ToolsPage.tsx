import { useState, useEffect } from 'react'

interface ToolInfo {
  name: string
  description: string
  type: 'builtin' | 'chain' | 'composite' | 'delegation' | string
  paramCount?: number
}

interface ToolsData {
  tools: ToolInfo[]
  toolCallCounts?: Record<string, number>
  toolErrorCounts?: Record<string, number>
}

export default function ToolsPage() {
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [callCounts, setCallCounts] = useState<Record<string, number>>({})
  const [errorCounts, setErrorCounts] = useState<Record<string, number>>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')

  useEffect(() => {
    Promise.all([
      fetch('/api/tools').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/metrics').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([toolsData, metricsData]: [ToolsData | null, Record<string, unknown> | null]) => {
      if (toolsData?.tools) {
        setTools(toolsData.tools)
      }
      if (metricsData) {
        setCallCounts((metricsData.toolCallCounts as Record<string, number>) ?? {})
        setErrorCounts((metricsData.toolErrorCounts as Record<string, number>) ?? {})

        // If no tools endpoint, synthesize from metrics
        if (!toolsData?.tools && metricsData.toolCallCounts) {
          const synth = Object.keys(metricsData.toolCallCounts as Record<string, number>).map(name => ({
            name,
            description: '',
            type: 'builtin' as const,
          }))
          setTools(synth)
        }
      }
      setLoading(false)
    }).catch(e => {
      setError(e.message)
      setLoading(false)
    })
  }, [])

  if (error) return <div className="page-error">Error: {error}</div>
  if (loading) return <div className="page-loading">Loading tools...</div>

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
                {calls > 0 && (
                  <span className="tool-tag">{calls} calls</span>
                )}
                {errors > 0 && (
                  <span className="tool-tag" style={{ background: 'rgba(255, 69, 58, 0.12)', color: 'var(--error)' }}>
                    {errors} errors
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
