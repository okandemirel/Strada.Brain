import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { usePersonality } from '../hooks/use-api'
import { PageSkeleton } from '../components/ui/page-skeleton'

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
  const queryClient = useQueryClient()
  const { data: rawData, error: fetchError, isLoading } = usePersonality()
  const data = rawData?.personality ?? null

  const [error, setError] = useState<string | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const [newName, setNewName] = useState('')
  const [newContent, setNewContent] = useState(PROFILE_TEMPLATE)
  const [createError, setCreateError] = useState<string | null>(null)

  const switchMutation = useMutation({
    mutationFn: async (profile: string) => {
      const res = await fetch('/api/personality/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile }) })
      if (!res.ok) { const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })); throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`) }
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['personality'] }) },
    onError: (err) => { setError(err instanceof Error ? err.message : String(err)) },
  })

  const deleteMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch(`/api/personality/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' })
      if (!res.ok) { const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })); throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`) }
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['personality'] }) },
    onError: (err) => { setError(err instanceof Error ? err.message : String(err)) },
  })

  const createMutation = useMutation({
    mutationFn: async ({ name, content }: { name: string; content: string }) => {
      const res = await fetch('/api/personality/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, content }) })
      if (!res.ok) { const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })); throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`) }
    },
    onSuccess: () => { setNewName(''); setNewContent(PROFILE_TEMPLATE); queryClient.invalidateQueries({ queryKey: ['personality'] }) },
    onError: (err) => { setCreateError(err instanceof Error ? err.message : String(err)) },
  })

  const handleSwitch = (profile: string) => { switchMutation.mutate(profile) }
  const handleDelete = (name: string) => { if (!confirm(`Delete custom profile "${name}"?`)) return; deleteMutation.mutate(name) }

  const handleCreate = () => {
    setCreateError(null)
    const trimmedName = newName.trim().toLowerCase()
    if (!trimmedName || !PROFILE_NAME_RE.test(trimmedName)) { setCreateError('Name must be alphanumeric, dash, or underscore only'); return }
    if (SYSTEM_PROFILES.has(trimmedName)) { setCreateError(`Cannot use "${trimmedName}" -- it is a system profile`); return }
    if (!newContent.trim()) { setCreateError('Content cannot be empty'); return }
    if (newContent.length > 10240) { setCreateError('Content exceeds 10KB limit'); return }
    createMutation.mutate({ name: trimmedName, content: newContent })
  }

  if (isLoading) return <PageSkeleton />

  return (
    <div className="h-full overflow-y-auto p-7 w-full animate-[admin-fade-in_0.3s_ease]">
      <h2 className="text-[22px] font-bold tracking-tight mb-6 text-text">Personality</h2>

      {error && (
        <div className="text-error text-[13px] mb-4 flex items-center gap-2">
          {error}
          <button className="px-3 py-1 border border-border rounded-lg bg-bg-tertiary text-text-secondary text-[11px] font-medium cursor-pointer hover:bg-bg-elevated" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {fetchError && !data ? (
        <div className="flex flex-col items-center justify-center h-[200px] gap-2.5 text-text-secondary text-center">
          <h3 className="text-text text-lg font-semibold">Personality Unavailable</h3>
          <p className="text-sm max-w-[400px]">The personality endpoint is not available. SOUL.md personality system may not be active or the API is not yet exposed.</p>
        </div>
      ) : (
        <>
          <div className="mb-7">
            <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">Active Profile</div>
            <div className="flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl mb-4 text-sm">
              <span className="text-text-secondary">Current Profile</span>
              <span className="text-text font-semibold">{data?.activeProfile ?? 'default'}</span>
            </div>
          </div>

          {data?.profiles && data.profiles.length > 0 && (
            <div className="mb-7">
              <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">Available Profiles</div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2.5 mt-3.5">
                {data.profiles.map(name => {
                  const isActive = name === data.activeProfile
                  const isSystem = SYSTEM_PROFILES.has(name)
                  return (
                    <div key={name} className={`bg-white/3 backdrop-blur border rounded-xl p-3.5 cursor-default transition-all duration-150 hover:border-border-hover ${isActive ? 'border-accent shadow-[0_0_0_2px_var(--color-accent-glow),0_0_12px_var(--color-accent-glow)]' : 'border-white/5'}`}>
                      <div className="text-sm font-semibold text-text mb-1 flex items-center gap-2">
                        {name}
                        {isActive && <span className="text-[10px] text-accent font-semibold uppercase">Active</span>}
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold uppercase ${isSystem ? 'bg-text-secondary/15 text-text-secondary' : 'bg-success/15 text-success'}`}>
                          {isSystem ? 'System' : 'Custom'}
                        </span>
                      </div>
                      <div className="flex gap-1.5 mt-2">
                        <button
                          className={`px-3 py-1 border border-border rounded-lg bg-bg-tertiary text-text-secondary text-[11px] font-medium cursor-pointer transition-all duration-150 hover:bg-bg-elevated hover:text-text ${isActive ? 'opacity-50 cursor-default' : ''}`}
                          disabled={isActive || switchMutation.isPending}
                          onClick={() => handleSwitch(name)}
                        >
                          {isActive ? 'Selected' : 'Select'}
                        </button>
                        {!isSystem && (
                          <button
                            className={`px-3 py-1 border border-error rounded-lg bg-bg-tertiary text-error text-[11px] font-medium cursor-pointer transition-all duration-150 hover:bg-error/10 ${deleteMutation.isPending && deleteMutation.variables === name ? 'opacity-50' : ''}`}
                            disabled={deleteMutation.isPending && deleteMutation.variables === name}
                            onClick={() => handleDelete(name)}
                          >
                            {deleteMutation.isPending && deleteMutation.variables === name ? 'Deleting...' : 'Delete'}
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {data?.channelOverrides && Object.keys(data.channelOverrides).length > 0 && (
            <div className="mb-7">
              <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">Channel Overrides</div>
              <table className="w-full bg-white/3 backdrop-blur border border-white/5 rounded-2xl overflow-hidden" style={{ borderSpacing: 0, borderCollapse: 'separate' }}>
                <thead>
                  <tr>
                    <th className="px-4 py-2.5 text-left bg-white/5 font-semibold text-text-secondary text-[11px] uppercase tracking-[0.04em] border-b border-white/5">Channel</th>
                    <th className="px-4 py-2.5 text-left bg-white/5 font-semibold text-text-secondary text-[11px] uppercase tracking-[0.04em] border-b border-white/5">Profile</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.channelOverrides).map(([ch, profile]) => (
                    <tr key={ch} className="hover:bg-white/5">
                      <td className="px-4 py-2.5 text-[13px] border-b border-border font-semibold">{ch}</td>
                      <td className="px-4 py-2.5 text-[13px] border-b border-border">{profile}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data?.content && (
            <div className="mb-7">
              <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">
                SOUL.md Content
                <button className="px-3 py-1 border border-border rounded-lg bg-bg-tertiary text-text-secondary text-[11px] font-medium cursor-pointer ml-auto hover:bg-bg-elevated" onClick={() => setShowRaw(!showRaw)}>
                  {showRaw ? 'Hide' : 'Show'}
                </button>
              </div>
              {showRaw && (
                <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 text-sm text-text leading-relaxed whitespace-pre-wrap break-words max-h-[500px] overflow-y-auto">{data.content}</div>
              )}
            </div>
          )}

          <div className="mb-7">
            <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">Create Profile</div>
            <div className="flex flex-col gap-3">
              <div>
                <label className="block text-xs text-text-secondary mb-1">Profile Name</label>
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="e.g. jarvis"
                  maxLength={64}
                  className="w-full max-w-[300px] px-3 py-2 text-[13px] bg-bg-secondary border border-border rounded-md text-text outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-glow)]"
                />
              </div>
              <div>
                <label className="block text-xs text-text-secondary mb-1">Content (Markdown)</label>
                <textarea
                  value={newContent}
                  onChange={e => setNewContent(e.target.value)}
                  rows={10}
                  maxLength={10240}
                  className="w-full px-3 py-2 text-[13px] font-mono bg-bg-secondary border border-border rounded-md text-text outline-none resize-y focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-glow)]"
                />
                <div className="text-[11px] text-text-secondary mt-1">
                  {newContent.length.toLocaleString()} / 10,240 bytes
                </div>
              </div>
              {createError && <div className="text-xs text-error">{createError}</div>}
              <button
                className={`self-start px-4 py-1.5 border border-border rounded-lg bg-bg-tertiary text-text-secondary text-xs font-medium cursor-pointer transition-all duration-150 hover:bg-bg-elevated hover:text-text ${createMutation.isPending || !newName.trim() ? 'opacity-50 cursor-not-allowed' : ''}`}
                disabled={createMutation.isPending || !newName.trim()}
                onClick={handleCreate}
              >
                {createMutation.isPending ? 'Creating...' : 'Create Profile'}
              </button>
            </div>
          </div>

          {!data?.content && !data?.profiles?.length && (
            <div className="flex flex-col items-center justify-center h-[200px] gap-2.5 text-text-secondary text-center">
              <h3 className="text-text text-lg font-semibold">No Personality Data</h3>
              <p className="text-sm max-w-[400px]">The personality API returned no data. SOUL.md may not be configured, or the API endpoint does not exist yet.</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
