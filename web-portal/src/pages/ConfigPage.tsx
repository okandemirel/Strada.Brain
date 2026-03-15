import { useState, useEffect } from 'react'

interface ConfigData {
  config: Record<string, unknown>
}

const CATEGORY_RULES: ReadonlyArray<[string, string[]]> = [
  ['Providers', ['provider', 'api_key']],
  ['Channels', ['channel', 'telegram', 'discord', 'slack', 'whatsapp']],
  ['Security', ['security', 'rate', 'limit']],
  ['RAG', ['rag', 'embedding']],
  ['Multi-Agent', ['agent', 'delegation']],
  ['Learning', ['goal', 'learning']],
]

export default function ConfigPage() {
  const [data, setData] = useState<ConfigData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(setData)
      .catch(e => setError(e.message))
  }, [])

  if (error) return <div className="page-error">Error: {error}</div>
  if (!data) return <div className="page-loading">Loading configuration...</div>

  const entries = Object.entries(data.config).filter(([key]) =>
    key.toLowerCase().includes(filter.toLowerCase())
  )

  const groups: Record<string, [string, unknown][]> = {}
  for (const entry of entries) {
    const lk = entry[0].toLowerCase()
    let category = 'System'
    for (const [cat, keywords] of CATEGORY_RULES) {
      if (keywords.some(kw => lk.includes(kw))) {
        category = cat
        break
      }
    }
    if (!groups[category]) groups[category] = []
    groups[category].push(entry)
  }

  return (
    <div className="admin-page">
      <h2>Configuration</h2>
      <input
        className="admin-search"
        type="text"
        placeholder="Filter settings..."
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />
      {Object.entries(groups).map(([category, items]) => (
        <div key={category} className="config-group">
          <h3>{category}</h3>
          <table className="admin-table">
            <tbody>
              {items.map(([key, value]) => (
                <tr key={key}>
                  <td className="config-key">{key}</td>
                  <td className="config-value">{String(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
