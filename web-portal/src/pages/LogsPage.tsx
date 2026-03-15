import { useState, useEffect, useRef, useCallback } from 'react'

interface LogEntry {
  timestamp: string
  level: string
  message: string
  module?: string
}

const LEVELS = ['all', 'debug', 'info', 'warn', 'error'] as const
type LevelFilter = typeof LEVELS[number]

function getLevelClass(level: string): string {
  const l = level.toLowerCase()
  if (l === 'error' || l === 'fatal') return 'error'
  if (l === 'warn' || l === 'warning') return 'warn'
  if (l === 'info') return 'info'
  return 'debug'
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString()
  } catch {
    return ts
  }
}

export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all')
  const [search, setSearch] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)

  const fetchLogs = useCallback(() => {
    fetch('/api/logs')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: { logs: LogEntry[] } | LogEntry[]) => {
        const entries = Array.isArray(data) ? data : data.logs ?? []
        setLogs(entries)
        setLoading(false)
      })
      .catch(e => {
        // If /api/logs doesn't exist, show empty state gracefully
        setError(e.message)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    fetchLogs()
    const interval = setInterval(fetchLogs, 5000)
    return () => clearInterval(interval)
  }, [fetchLogs])

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [logs, autoScroll])

  if (loading) return <div className="page-loading">Loading logs...</div>

  const filtered = logs.filter(entry => {
    if (levelFilter !== 'all' && getLevelClass(entry.level) !== levelFilter) return false
    if (search && !entry.message.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const levelCounts = logs.reduce<Record<string, number>>((acc, e) => {
    const cls = getLevelClass(e.level)
    acc[cls] = (acc[cls] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="admin-page">
      <h2>Logs</h2>

      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          className="admin-search"
          type="text"
          placeholder="Search logs..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ marginBottom: 0 }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={e => setAutoScroll(e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
          />
          Auto-scroll
        </label>
      </div>

      <div className="admin-filter-bar">
        {LEVELS.map(level => (
          <button
            key={level}
            className={`admin-filter-btn ${levelFilter === level ? 'active' : ''}`}
            onClick={() => setLevelFilter(level)}
          >
            {level === 'all' ? 'All' : level}
            {level !== 'all' && levelCounts[level] ? ` (${levelCounts[level]})` : ''}
          </button>
        ))}
      </div>

      {error && logs.length === 0 ? (
        <div className="page-empty">
          <h3>Logs Unavailable</h3>
          <p>The log endpoint is not available. Logs may not be exposed via the API yet.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="page-empty">
          <h3>No Matching Logs</h3>
          <p>No log entries match the current filters.</p>
        </div>
      ) : (
        <div className="log-container" ref={containerRef}>
          {filtered.map((entry, i) => (
            <div key={i} className="log-entry">
              <span className="log-timestamp">{formatTimestamp(entry.timestamp)}</span>
              <span className={`level-badge ${getLevelClass(entry.level)}`}>{entry.level}</span>
              <span className="log-message">
                {entry.module ? `[${entry.module}] ` : ''}{entry.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
