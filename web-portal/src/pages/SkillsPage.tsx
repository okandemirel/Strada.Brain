import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { useSkills, useSkillRegistry } from '../hooks/use-api'
import type { SkillEntryResponse, RegistrySkillEntry } from '../hooks/use-api'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'

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
// Toggle button
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
      aria-label={isActive ? `${skill.manifest.name}` : `${skill.manifest.name}`}
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
// Installed tab content
// ---------------------------------------------------------------------------

function InstalledTab() {
  const { t } = useTranslation('pages')
  const skillsQuery = useSkills()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const { data, error, isLoading } = skillsQuery

  if (isLoading) {
    return (
      <div className="space-y-3 mt-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-14 rounded-xl bg-bg-tertiary animate-pulse" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-[200px] gap-3 text-text-secondary">
        <div className="text-4xl">⚠</div>
        <h3 className="text-text text-lg font-semibold">{t('skills.installed.failedTitle')}</h3>
        <p className="text-sm max-w-[400px] text-center">{error.message}</p>
      </div>
    )
  }

  const skills: SkillEntryResponse[] = data?.skills ?? []

  if (skills.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[200px] gap-2.5 text-text-secondary text-center">
        <h3 className="text-text text-lg font-semibold">{t('skills.installed.noSkillsTitle')}</h3>
        <p className="text-sm max-w-[400px]">
          {t('skills.installed.noSkillsDescription')}
        </p>
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
    await queryClient.invalidateQueries({ queryKey: ['skills'] })
  }

  return (
    <div>
      {/* Search */}
      <input
        className="w-full max-w-[400px] px-4 py-2.5 border border-border rounded-xl bg-input-bg text-text font-[inherit] text-sm outline-none transition-all duration-200 mb-5 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-glow)] placeholder:text-text-tertiary"
        type="text"
        placeholder={t('skills.installed.searchPlaceholder')}
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
            {s === 'all' ? t('skills.installed.filterAll') : s}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-[14px] border border-border">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-bg-secondary border-b border-border">
              <th className="text-left px-4 py-3 text-text-secondary font-semibold text-[12px] uppercase tracking-wide">{t('skills.installed.columnName')}</th>
              <th className="text-left px-4 py-3 text-text-secondary font-semibold text-[12px] uppercase tracking-wide">{t('skills.installed.columnDescription')}</th>
              <th className="text-left px-4 py-3 text-text-secondary font-semibold text-[12px] uppercase tracking-wide">{t('skills.installed.columnVersion')}</th>
              <th className="text-left px-4 py-3 text-text-secondary font-semibold text-[12px] uppercase tracking-wide">{t('skills.installed.columnTier')}</th>
              <th className="text-left px-4 py-3 text-text-secondary font-semibold text-[12px] uppercase tracking-wide">{t('skills.installed.columnStatus')}</th>
              <th className="text-left px-4 py-3 text-text-secondary font-semibold text-[12px] uppercase tracking-wide">{t('skills.installed.columnActions')}</th>
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
            {t('skills.installed.noFilterMatch')}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Marketplace tab content
// ---------------------------------------------------------------------------

function MarketplaceTab() {
  const { t } = useTranslation('pages')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [installing, setInstalling] = useState<string | null>(null)
  const queryClient = useQueryClient()

  // Debounce search
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current) }, [])
  const handleSearch = (value: string) => {
    setSearch(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedSearch(value), 300)
  }

  const { data, error, isLoading } = useSkillRegistry(debouncedSearch)

  const handleInstall = async (skill: RegistrySkillEntry) => {
    setInstalling(skill.name)
    try {
      const res = await fetch('/api/skills/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: skill.name, repo: skill.repo }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `Install failed: ${res.status}`)
      }
      // Refresh both installed skills and registry
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['skills'] }),
        queryClient.invalidateQueries({ queryKey: ['skill-registry'] }),
      ])
    } catch (err) {
      // Show error in console for now (could be enhanced with toast)
      console.error('Install failed:', err)
    } finally {
      setInstalling(null)
    }
  }

  return (
    <div>
      {/* Search */}
      <input
        className="w-full max-w-[400px] px-4 py-2.5 border border-border rounded-xl bg-input-bg text-text font-[inherit] text-sm outline-none transition-all duration-200 mb-5 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-glow)] placeholder:text-text-tertiary"
        type="text"
        placeholder={t('skills.marketplace.searchPlaceholder')}
        value={search}
        onChange={(e) => handleSearch(e.target.value)}
      />

      {/* Loading state */}
      {isLoading && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-[160px] rounded-xl bg-bg-tertiary animate-pulse" />
          ))}
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="flex flex-col items-center justify-center h-[200px] gap-3 text-text-secondary">
          <div className="text-4xl">⚠</div>
          <h3 className="text-text text-lg font-semibold">{t('skills.marketplace.failedTitle')}</h3>
          <p className="text-sm max-w-[400px] text-center">{error.message}</p>
        </div>
      )}

      {/* Results */}
      {data && !isLoading && (
        <>
          {data.skills.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-[200px] gap-2.5 text-text-secondary text-center">
              <h3 className="text-text text-lg font-semibold">{t('skills.marketplace.noSkillsTitle')}</h3>
              <p className="text-sm max-w-[400px]">
                {debouncedSearch
                  ? t('skills.marketplace.noSkillsSearchDescription', { query: debouncedSearch })
                  : t('skills.marketplace.noSkillsEmptyDescription')}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
              {data.skills.map((skill) => (
                <div
                  key={skill.name}
                  className="rounded-xl border border-white/5 bg-white/3 backdrop-blur p-5 flex flex-col gap-3 hover:border-border-hover hover:-translate-y-px hover:shadow-[var(--shadow-sm)] transition-all duration-200"
                >
                  {/* Header */}
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="font-mono text-[14px] font-semibold text-text">{skill.name}</h3>
                      {skill.author && (
                        <span className="text-[11px] text-text-tertiary">{t('skills.marketplace.byAuthor', { author: skill.author })}</span>
                      )}
                    </div>
                    <span className="text-[11px] text-text-tertiary whitespace-nowrap">v{skill.version}</span>
                  </div>

                  {/* Description */}
                  <p className="text-[13px] text-text-secondary line-clamp-2 flex-1">
                    {skill.description}
                  </p>

                  {/* Tags */}
                  {skill.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {skill.tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-[10px] px-2 py-0.5 rounded-md bg-bg-tertiary text-text-tertiary"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Install button */}
                  <div className="pt-1">
                    {skill.installed ? (
                      <span className="text-[12px] font-semibold text-success px-3 py-1.5 rounded-lg bg-success/10 border border-success/20 inline-block">
                        {t('skills.marketplace.installed')}
                      </span>
                    ) : (
                      <button
                        onClick={() => handleInstall(skill)}
                        disabled={installing === skill.name}
                        className="px-3 py-1.5 rounded-lg text-[12px] font-semibold border border-accent/40 bg-accent-glow text-accent hover:bg-accent/20 transition-all duration-150 font-[inherit] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {installing === skill.name ? t('skills.marketplace.installing') : t('skills.marketplace.install')}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page with tabs
// ---------------------------------------------------------------------------

export default function SkillsPage() {
  const { t } = useTranslation('pages')
  return (
    <div className="h-full overflow-y-auto p-7 w-full animate-[admin-fade-in_0.3s_ease]">
      <h2 className="text-[22px] font-bold tracking-tight mb-2 text-text">{t('skills.title')}</h2>
      <p className="text-sm text-text-tertiary mb-6">
        {t('skills.description')}
      </p>

      <Tabs defaultValue="installed" className="w-full">
        <TabsList className="mb-6">
          <TabsTrigger value="installed">{t('skills.tabInstalled')}</TabsTrigger>
          <TabsTrigger value="marketplace">{t('skills.tabMarketplace')}</TabsTrigger>
        </TabsList>

        <TabsContent value="installed">
          <InstalledTab />
        </TabsContent>

        <TabsContent value="marketplace">
          <MarketplaceTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
