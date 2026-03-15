import { useState, useEffect } from 'react'

interface PersonalityData {
  content?: string
  activeProfile?: string
  profiles?: string[]
  channelOverrides?: Record<string, string>
}

const SYSTEM_PROFILES = new Set(['default', 'casual', 'formal', 'minimal'])
const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]+$/

const PROFILE_TEMPLATE = `# Identity
You are ...

# Personality
- Tone: ...
- Style: ...

# Rules
- ...
`

export default function PersonalityPage() {
  const [data, setData] = useState<PersonalityData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showRaw, setShowRaw] = useState(false)

  // Switch state
  const [switching, setSwitching] = useState(false)

  // Delete state
  const [deleting, setDeleting] = useState<string | null>(null)

  // Create form state
  const [newName, setNewName] = useState('')
  const [newContent, setNewContent] = useState(PROFILE_TEMPLATE)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const fetchPersonality = () => {
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
  }

  useEffect(() => {
    fetchPersonality()
  }, [])

  const handleSwitch = async (profile: string) => {
    setSwitching(true)
    try {
      const res = await fetch('/api/personality/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      fetchPersonality()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSwitching(false)
    }
  }

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete custom profile "${name}"?`)) return
    setDeleting(name)
    try {
      const res = await fetch(`/api/personality/profiles/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      fetchPersonality()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeleting(null)
    }
  }

  const handleCreate = async () => {
    setCreateError(null)
    const trimmedName = newName.trim().toLowerCase()
    if (!trimmedName || !PROFILE_NAME_RE.test(trimmedName)) {
      setCreateError('Name must be alphanumeric, dash, or underscore only')
      return
    }
    if (SYSTEM_PROFILES.has(trimmedName)) {
      setCreateError(`Cannot use "${trimmedName}" — it is a system profile`)
      return
    }
    if (!newContent.trim()) {
      setCreateError('Content cannot be empty')
      return
    }
    if (newContent.length > 10240) {
      setCreateError('Content exceeds 10KB limit')
      return
    }

    setCreating(true)
    try {
      const res = await fetch('/api/personality/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, content: newContent }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      setNewName('')
      setNewContent(PROFILE_TEMPLATE)
      fetchPersonality()
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  if (loading) return <div className="page-loading">Loading personality...</div>

  return (
    <div className="admin-page">
      <h2>Personality</h2>

      {error && (
        <div className="page-error" style={{ color: 'var(--danger, #ef4444)', marginBottom: '16px', fontSize: '13px' }}>
          {error}
          <button
            className="admin-filter-btn"
            onClick={() => setError(null)}
            style={{ marginLeft: '8px', fontSize: '11px' }}
          >
            Dismiss
          </button>
        </div>
      )}

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
                {data.profiles.map(name => {
                  const isActive = name === data.activeProfile
                  const isSystem = SYSTEM_PROFILES.has(name)
                  return (
                    <div key={name} className={`profile-card ${isActive ? 'active' : ''}`}>
                      <div className="profile-card-name" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {name}
                        {isActive && (
                          <span style={{ fontSize: '10px', color: 'var(--accent)', fontWeight: 600, textTransform: 'uppercase' }}>
                            Active
                          </span>
                        )}
                        <span style={{
                          fontSize: '9px',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          background: isSystem ? 'rgba(100, 116, 139, 0.15)' : 'rgba(34, 197, 94, 0.15)',
                          color: isSystem ? 'var(--text-secondary, #94a3b8)' : 'var(--success, #22c55e)',
                        }}>
                          {isSystem ? 'System' : 'Custom'}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                        <button
                          className="admin-filter-btn"
                          disabled={isActive || switching}
                          onClick={() => handleSwitch(name)}
                          style={{ fontSize: '11px', opacity: isActive ? 0.5 : 1 }}
                        >
                          {isActive ? 'Selected' : 'Select'}
                        </button>
                        {!isSystem && (
                          <button
                            className="admin-filter-btn"
                            disabled={deleting === name}
                            onClick={() => handleDelete(name)}
                            style={{
                              fontSize: '11px',
                              color: 'var(--danger, #ef4444)',
                              borderColor: 'var(--danger, #ef4444)',
                              opacity: deleting === name ? 0.5 : 1,
                            }}
                          >
                            {deleting === name ? 'Deleting...' : 'Delete'}
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
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

          {/* Create Profile */}
          <div className="admin-section">
            <div className="admin-section-title">Create Profile</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Profile Name
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="e.g. jarvis"
                  maxLength={64}
                  style={{
                    width: '100%',
                    maxWidth: '300px',
                    padding: '8px 12px',
                    fontSize: '13px',
                    background: 'var(--bg-secondary, #1e293b)',
                    border: '1px solid var(--border, #334155)',
                    borderRadius: '6px',
                    color: 'var(--text-primary, #e2e8f0)',
                    outline: 'none',
                  }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Content (Markdown)
                </label>
                <textarea
                  value={newContent}
                  onChange={e => setNewContent(e.target.value)}
                  rows={10}
                  maxLength={10240}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: '13px',
                    fontFamily: 'monospace',
                    background: 'var(--bg-secondary, #1e293b)',
                    border: '1px solid var(--border, #334155)',
                    borderRadius: '6px',
                    color: 'var(--text-primary, #e2e8f0)',
                    outline: 'none',
                    resize: 'vertical',
                  }}
                />
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                  {newContent.length.toLocaleString()} / 10,240 bytes
                </div>
              </div>
              {createError && (
                <div style={{ fontSize: '12px', color: 'var(--danger, #ef4444)' }}>
                  {createError}
                </div>
              )}
              <button
                className="admin-filter-btn"
                disabled={creating || !newName.trim()}
                onClick={handleCreate}
                style={{
                  alignSelf: 'flex-start',
                  fontSize: '12px',
                  padding: '6px 16px',
                  opacity: creating || !newName.trim() ? 0.5 : 1,
                }}
              >
                {creating ? 'Creating...' : 'Create Profile'}
              </button>
            </div>
          </div>

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
