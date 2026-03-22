import { useState, useEffect, useRef } from 'react'
import { useLogs } from '../hooks/use-api'

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

function getLevelBadgeClass(cls: string): string {
  switch (cls) {
    case 'info': return 'bg-accent/10 text-accent'
    case 'warn': return 'bg-warning/10 text-warning'
    case 'error': return 'bg-error/10 text-error'
    default: return 'bg-bg-tertiary text-text-tertiary'
  }
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
  const logsQuery = useLogs()
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all')
  const [search, setSearch] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)

  const rawData = logsQuery.data
  const logs: LogEntry[] = rawData
    ? (Array.isArray(rawData) ? rawData : (rawData as { logs?: LogEntry[] }).logs ?? [])
    : []

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [logs, autoScroll])

  if (logsQuery.isLoading) return <div className="flex flex-1 items-center justify-center h-[200px] text-text-secondary text-[15px]">Loading logs...</div>

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
    <div className="flex-1 overflow-y-auto p-7 w-full animate-[admin-fade-in_0.3s_ease]">
      <h2 className="text-[22px] font-bold tracking-tight mb-6 text-text">Logs</h2>

      <div className="flex gap-3 mb-4 items-center flex-wrap">
        <input
          className="w-full max-w-[400px] px-4 py-2.5 border border-border rounded-xl bg-input-bg text-text font-[inherit] text-sm outline-none transition-all duration-200 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-glow)] placeholder:text-text-tertiary"
          type="text"
          placeholder="Search logs..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <label className="flex items-center gap-1.5 text-[13px] text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={e => setAutoScroll(e.target.checked)}
            className="accent-accent"
          />
          Auto-scroll
        </label>
      </div>

      <div className="flex gap-2 mb-5 flex-wrap items-center">
        {LEVELS.map(level => (
          <button
            key={level}
            className={`px-3.5 py-1.5 border rounded-lg font-[inherit] text-[13px] font-medium cursor-pointer transition-all duration-150 ${
              levelFilter === level
                ? 'bg-accent-glow text-accent border-accent font-semibold'
                : 'border-border bg-bg-tertiary text-text-secondary hover:bg-bg-elevated hover:text-text hover:border-border-hover'
            }`}
            onClick={() => setLevelFilter(level)}
          >
            {level === 'all' ? 'All' : level}
            {level !== 'all' && levelCounts[level] ? ` (${levelCounts[level]})` : ''}
          </button>
        ))}
      </div>

      {logsQuery.isError && logs.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-[200px] gap-2.5 text-text-secondary text-center">
          <h3 className="text-text text-lg font-semibold">Logs Unavailable</h3>
          <p className="text-sm max-w-[400px]">The log endpoint is not available. Logs may not be exposed via the API yet.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-[200px] gap-2.5 text-text-secondary text-center">
          <h3 className="text-text text-lg font-semibold">No Matching Logs</h3>
          <p className="text-sm max-w-[400px]">No log entries match the current filters.</p>
        </div>
      ) : (
        <div className="bg-bg-secondary border border-border rounded-[14px] overflow-hidden max-h-[calc(100vh-260px)] overflow-y-auto" ref={containerRef}>
          {filtered.map((entry, i) => (
            <div key={i} className="flex items-start gap-3 px-4 py-2 border-b border-border text-[13px] transition-colors hover:bg-bg-tertiary last:border-b-0 max-md:flex-col max-md:gap-1">
              <span className="font-mono text-[11px] text-text-tertiary whitespace-nowrap shrink-0 min-w-[80px]">{formatTimestamp(entry.timestamp)}</span>
              <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-[0.04em] min-w-[50px] text-center ${getLevelBadgeClass(getLevelClass(entry.level))}`}>{entry.level}</span>
              <span className="text-text font-mono text-xs leading-relaxed break-words flex-1">
                {entry.module ? `[${entry.module}] ` : ''}{entry.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
