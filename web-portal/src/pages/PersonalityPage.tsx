import { useState, useEffect } from 'react'

interface PersonalityData {
  content?: string
  activeProfile?: string
  profiles?: string[]
  channelOverrides?: Record<string, string>
}

export default function PersonalityPage() {
  const [data, setData] = useState<PersonalityData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showRaw, setShowRaw] = useState(false)

  useEffect(() => {
    fetch('/api/personality')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((d: { personality: PersonalityData | null }) => {
        setData(d.personality)
        setLoading(false)
      })
      .catch(e => {
        setError(e.message)
        setLoading(false)
      })
  }, [])

  if (loading) return <div className="page-loading">Loading personality...</div>

  return (
    <div className="admin-page">
      <h2>Personality</h2>

      {error && !data ? (
        <div className="page-empty">
          <h3>Personality Unavailable</h3>
          <p>The personality endpoint is not available. SOUL.md personality system may not be active or the API is not yet exposed.</p>
        </div>
      ) : (
        <>
          {/* Active Profile */}
          <div className="admin-section">
            <div className="admin-section-title">Active Profile</div>
            <div className="admin-stat-row" style={{ marginBottom: '16px' }}>
              <span className="admin-stat-label">Current Profile</span>
              <span className="admin-stat-value">{data?.activeProfile ?? 'default'}</span>
            </div>
          </div>

          {/* Profiles */}
          {data?.profiles && data.profiles.length > 0 && (
            <div className="admin-section">
              <div className="admin-section-title">Available Profiles</div>
              <div className="profile-grid">
                {data.profiles.map(name => (
                  <div key={name} className={`profile-card ${name === data.activeProfile ? 'active' : ''}`}>
                    <div className="profile-card-name">
                      {name}
                      {name === data.activeProfile && (
                        <span style={{ marginLeft: '8px', fontSize: '10px', color: 'var(--accent)', fontWeight: 600, textTransform: 'uppercase' }}>
                          Active
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Channel Overrides */}
          {data?.channelOverrides && Object.keys(data.channelOverrides).length > 0 && (
            <div className="admin-section">
              <div className="admin-section-title">Channel Overrides</div>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Profile</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.channelOverrides).map(([ch, profile]) => (
                    <tr key={ch}>
                      <td style={{ fontWeight: 600 }}>{ch}</td>
                      <td>{profile}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Soul Content */}
          {data?.content && (
            <div className="admin-section">
              <div className="admin-section-title">
                SOUL.md Content
                <button
                  className="admin-filter-btn"
                  onClick={() => setShowRaw(!showRaw)}
                  style={{ marginLeft: 'auto' }}
                >
                  {showRaw ? 'Hide' : 'Show'}
                </button>
              </div>
              {showRaw && (
                <div className="soul-content">{data.content}</div>
              )}
            </div>
          )}

          {/* Fallback: no data from endpoint */}
          {!data?.content && !data?.profiles?.length && (
            <div className="page-empty">
              <h3>No Personality Data</h3>
              <p>The personality API returned no data. SOUL.md may not be configured, or the API endpoint does not exist yet.</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
