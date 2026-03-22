import { useState } from 'react'
import { useConfig } from '../hooks/use-api'

interface ConfigEntry {
  key: string
  value: unknown
  category: string
  tier: 'core' | 'advanced' | 'experimental'
  description: string
}

export default function ConfigPage() {
  const { data, error, isLoading } = useConfig()
  const [filter, setFilter] = useState('')

  if (error) return <div className="page-error">Error: {error.message}</div>
  if (isLoading || !data) return <div className="page-loading">Loading configuration...</div>

  const normalizedFilter = filter.toLowerCase()
  const fallbackEntries: ConfigEntry[] = Object.entries(data.config).map(([key, value]) => ({
    key,
    value,
    category: 'System',
    tier: 'advanced',
    description: 'General runtime configuration.',
  }))
  const rawEntries = (data.entries as ConfigEntry[] | undefined) ?? fallbackEntries
  const filteredEntries = rawEntries.filter((entry) =>
    entry.key.toLowerCase().includes(normalizedFilter) ||
    entry.category.toLowerCase().includes(normalizedFilter) ||
    entry.description.toLowerCase().includes(normalizedFilter)
  )

  const groups: Record<string, ConfigEntry[]> = {}
  for (const entry of filteredEntries) {
    if (!groups[entry.category]) groups[entry.category] = []
    groups[entry.category].push(entry)
  }
  const groupedEntries = Object.entries(groups)

  return (
    <div className="admin-page">
      <h2>Configuration</h2>
      {data.summary && (
        <div className="admin-stat-grid" style={{ marginBottom: 16 }}>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Core</span>
            <span className="admin-stat-value">{data.summary.core}</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Advanced</span>
            <span className="admin-stat-value">{data.summary.advanced}</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-label">Experimental</span>
            <span className="admin-stat-value">{data.summary.experimental}</span>
          </div>
        </div>
      )}
      <input
        className="admin-search"
        type="text"
        placeholder="Filter settings..."
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />
      {groupedEntries.length === 0 ? (
        <div className="config-group">
          <table className="admin-table">
            <tbody>
              <tr>
                <td className="config-key">No matching settings</td>
                <td className="config-value">Adjust the filter to inspect this category.</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        groupedEntries.map(([category, items]) => (
          <div key={category} className="config-group">
            <h3>{category}</h3>
            <table className="admin-table">
              <tbody>
                {items.map((entry) => (
                  <tr key={entry.key}>
                    <td className="config-key">
                      <div>{entry.key}</div>
                      <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>{entry.description}</div>
                    </td>
                    <td className="config-value">
                      <div>{String(entry.value)}</div>
                      <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>Tier: {entry.tier}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </div>
  )
}
