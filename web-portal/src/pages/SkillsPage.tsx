import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSkills } from '../hooks/use-api'
import type { SkillEntryResponse } from '../hooks/use-api'

// ---------------------------------------------------------------------------
// Status badge helpers
// ---------------------------------------------------------------------------

type SkillStatus = SkillEntryResponse['status']

const STATUS_BADGE: Record<SkillStatus, string> = {
  active: 'bg-success/10 text-success',
  disabled: 'bg-bg-tertiary text-text-tertiary',
  gated: 'bg-warning/10 text-warning',
  error: 'bg-error/10 text-error',
}

const TIER_BADGE: Record<SkillEntryResponse['tier'], string> = {
  workspace: 'bg-accent-glow text-accent',
  managed: 'bg-bg-tertiary text-text-tertiary',
  bundled: 'bg-bg-tertiary text-text-secondary',
  extra: 'bg-bg-tertiary text-text-tertiary',
}

function StatusBadge({ status }: { status: SkillStatus }) {
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] ${STATUS_BADGE[status]}`}>
      {status}
    </span>
  )
}

function TierBadge({ tier }: { tier: SkillEntryResponse['tier'] }) {
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-[0.03em] ${TIER_BADGE[tier]}`}>
      {tier}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Toggle button with optimistic loading state
// ---------------------------------------------------------------------------

interface ToggleButtonProps {
  skill: SkillEntryResponse
  onToggle: (name: string, enable: boolean) => Promise<void>
}

function ToggleButton({ skill, onToggle }: ToggleButtonProps) {
  const [pending, setPending] = useState(false)
  const isActive = skill.status === 'active'
  const isGated = skill.status === 'gated'
  const isError = skill.status === 'error'

  const handleClick = async () => {
    setPending(true)
    try {
      await onToggle(skill.manifest.name, !isActive)
    } finally {
      setPending(false)
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={pending || isGated || isError}
      aria-label={isActive ? `Disable ${skill.manifest.name}` : `Enable ${skill.manifest.name}`}
      className={`px-3 py-1 rounded-lg text-[12px] font-semibold border transition-all duration-150 font-[inherit] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
        isActive
          ? 'border-error/40 bg-error/10 text-error hover:bg-error/20'
          : 'border-success/40 bg-success/10 text-success hover:bg-success/20'
      }`}
    >
      {pending ? '...' : isActive ? 'Disable' : 'Enable'}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function SkillsPage() {
  const skillsQuery = useSkills()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const { data, error, isLoading } = skillsQuery

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center h-[200px] text-text-secondary text-[15px]">
        Loading skills...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center h-[200px] text-error text-[15px]">
        Error: {error.message}
      </div>
    )
  }

  const skills: SkillEntryResponse[] = data?.skills ?? []

  if (skills.length === 0) {
    return (
      <div className="h-full overflow-y-auto p-7 w-full animate-[admin-fade-in_0.3s_ease]">
        <h2 className="text-[22px] font-bold tracking-tight mb-6 text-text">Skills</h2>
        <div className="flex flex-col items-center justify-center h-[200px] gap-2.5 text-text-secondary text-center">
          <h3 className="text-text text-lg font-semibold">No Skills Loaded</h3>
          <p className="text-sm max-w-[400px]">
            No skills are currently registered. Add skill folders or install skills via the CLI.
          </p>
        </div>
      </div>
    )
  }

  const statuses = ['all', ...Array.from(new Set(skills.map((s) => s.status)))]

  const filtered = skills.filter((s) => {
    const query = filter.toLowerCase()
    const matchesText =
      s.manifest.name.toLowerCase().includes(query) ||
      s.manifest.description.toLowerCase().includes(query)
    const matchesStatus = statusFilter === 'all' || s.status === statusFilter
    return matchesText && matchesStatus
  })

  const handleToggle = async (name: string, enable: boolean) => {
    const endpoint = `/api/skills/${encodeURIComponent(name)}/${enable ? 'enable' : 'disable'}`
    const res = await fetch(endpoint, { method: 'POST' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error ?? `Request failed: ${res.status}`)
    }
    // Refresh the skills list so status reflects the config change
    await queryClient.invalidateQueries({ queryKey: ['skills'] })
  }

  return (
    <div className="h-full overflow-y-auto p-7 w-full animate-[admin-fade-in_0.3s_ease]">
      <h2 className="text-[22px] font-bold tracking-tight mb-2 text-text">
        Skills ({skills.length})
      </h2>
      <p className="text-sm text-text-tertiary mb-6">
        Manage which skills are enabled. Changes take effect on next restart.
      </p>

      {/* Search */}
      <input
        className="w-full max-w-[400px] px-4 py-2.5 border border-border rounded-xl bg-input-bg text-text font-[inherit] text-sm outline-none transition-all duration-200 mb-5 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-glow)] placeholder:text-text-tertiary"
        type="text"
        placeholder="Search skills..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      {/* Status filter pills */}
      <div className="flex gap-2 mb-5 flex-wrap items-center">
        {statuses.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3.5 py-1.5 border rounded-lg font-[inherit] text-[13px] font-medium cursor-pointer transition-all duration-150 ${
              statusFilter === s
                ? 'bg-accent-glow text-accent border-accent font-semibold'
                : 'border-border bg-bg-tertiary text-text-secondary hover:bg-bg-elevated hover:text-text hover:border-border-hover'
            }`}
          >
            {s === 'all' ? 'All' : s}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-[14px] border border-border">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-bg-secondary border-b border-border">
              <th className="text-left px-4 py-3 text-text-secondary font-semibold text-[12px] uppercase tracking-wide">
                Name
              </th>
              <th className="text-left px-4 py-3 text-text-secondary font-semibold text-[12px] uppercase tracking-wide">
                Description
              </th>
              <th className="text-left px-4 py-3 text-text-secondary font-semibold text-[12px] uppercase tracking-wide">
                Version
              </th>
              <th className="text-left px-4 py-3 text-text-secondary font-semibold text-[12px] uppercase tracking-wide">
                Tier
              </th>
              <th className="text-left px-4 py-3 text-text-secondary font-semibold text-[12px] uppercase tracking-wide">
                Status
              </th>
              <th className="text-left px-4 py-3 text-text-secondary font-semibold text-[12px] uppercase tracking-wide">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((skill) => (
              <tr
                key={skill.manifest.name}
                className="border-b border-border last:border-b-0 hover:bg-bg-secondary transition-colors duration-100"
              >
                <td className="px-4 py-3 font-mono text-[13px] font-semibold text-text whitespace-nowrap">
                  {skill.manifest.name}
                </td>
                <td className="px-4 py-3 text-text-secondary text-[13px] max-w-xs">
                  <span className="line-clamp-2">{skill.manifest.description}</span>
                  {skill.gateReason && (
                    <span className="block text-[11px] text-warning mt-0.5">{skill.gateReason}</span>
                  )}
                </td>
                <td className="px-4 py-3 text-text-tertiary text-[12px] whitespace-nowrap">
                  {skill.manifest.version}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <TierBadge tier={skill.tier} />
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <StatusBadge status={skill.status} />
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <ToggleButton skill={skill} onToggle={handleToggle} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-center py-8 text-text-tertiary text-sm">
            No skills match your filter.
          </div>
        )}
      </div>
    </div>
  )
}
