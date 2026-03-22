import { useState, useCallback, useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useWS } from '../hooks/useWS'
import { useAutonomousStatus, useProviders, useRagStatus, useDaemon, useAgentActivity, useBootReport } from '../hooks/use-api'
import { resolveSettingsIdentity, shouldRefetchIdentityScopedSettings } from './settings-identity'
import PrimaryWorkerSelector from '../components/PrimaryWorkerSelector'
import type { BootReport } from '../../../src/common/capability-contract.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AutonomousStatus {
  enabled: boolean
  expiresAt?: number
  remainingMs?: number
}

interface ProviderInfo {
  name: string
  label: string
  defaultModel: string
}

interface ActiveProvider {
  providerName: string
  model: string
  isDefault: boolean
  selectionMode?: string
  executionPolicyNote?: string
  executionPool?: ProviderInfo[]
}

interface RoutingDecision {
  provider: string
  reason: string
  task: {
    type: string
    complexity: string
    criticality: string
  }
  timestamp: number
  catalogSignal?: {
    freshnessScore: number
    alignmentScore: number
    stale: boolean
    updatedAt?: number
  }
}

interface ExecutionTrace {
  provider: string
  model?: string
  role: string
  phase: string
  source: string
  reason: string
  task: {
    type: string
    complexity: string
    criticality: string
  }
  timestamp: number
}

interface PhaseOutcome {
  provider: string
  model?: string
  role: string
  phase: string
  source: string
  status: string
  reason: string
  task: {
    type: string
    complexity: string
    criticality: string
  }
  timestamp: number
}

interface PhaseScore {
  provider: string
  role: string
  phase: string
  sampleSize: number
  score: number
  approvedCount: number
  continuedCount: number
  replannedCount: number
  blockedCount: number
  failedCount: number
  verifierSampleSize: number
  verifierCleanRate: number
  rollbackRate: number
  avgRetryCount: number
  avgTokenCost: number
  repeatedFailureCount: number
  latestTimestamp: number
  latestReason: string
}

interface RuntimeArtifact {
  id: string
  kind: 'skill' | 'workflow' | 'knowledge_patch'
  state: 'shadow' | 'active' | 'retired' | 'rejected'
  name: string
  description: string
  projectWorldFingerprint?: string
  stats: {
    shadowSampleCount: number
    activeUseCount: number
    cleanCount: number
    retryCount: number
    failureCount: number
    blockerCount: number
  }
  lastStateReason?: string
  updatedAt: number
}

interface EmbeddingStatus {
  state: 'disabled' | 'active' | 'degraded'
  ragEnabled: boolean
  configuredProvider: string
  configuredModel?: string
  configuredDimensions?: number
  resolvedProviderName?: string
  resolutionSource?: string
  activeDimensions?: number
  verified: boolean
  usingHashFallback: boolean
  notice?: string
}

interface DaemonStatus {
  running: boolean
  configured?: boolean
  intervalMs?: number
  triggers: Array<{ name: string; type: string; state: string; circuitState: string; nextRun: string | null }>
  budget: { usedUsd: number; limitUsd: number; pct: number }
  approvalQueue: Array<{ id: string; toolName: string; triggerName?: string; status: string }>
  startupNotices?: string[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VOICE_STORAGE_KEY = 'strada-voice-settings'

interface VoiceSettings {
  inputEnabled: boolean
  outputEnabled: boolean
}

function loadVoiceSettings(): VoiceSettings {
  try {
    const raw = localStorage.getItem(VOICE_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<VoiceSettings>
      return {
        inputEnabled: Boolean(parsed.inputEnabled),
        outputEnabled: Boolean(parsed.outputEnabled),
      }
    }
  } catch {
    // Corrupted storage — fall through to defaults
  }
  return { inputEnabled: false, outputEnabled: false }
}

function saveVoiceSettings(settings: VoiceSettings): void {
  localStorage.setItem(VOICE_STORAGE_KEY, JSON.stringify(settings))
}

function hasSpeechRecognition(): boolean {
  return Boolean(
    (window as unknown as Record<string, unknown>).SpeechRecognition ||
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition,
  )
}

function hasSpeechSynthesis(): boolean {
  return typeof window.speechSynthesis !== 'undefined'
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'Expired'
  const totalMinutes = Math.floor(ms / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) return `${hours}h ${minutes}m remaining`
  return `${minutes}m remaining`
}

function toPercent(pct: number): number {
  return pct * 100
}

function formatDecisionTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return 'recently'
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const queryClient = useQueryClient()
  const { toggleAutonomous, sessionId, profileId } = useWS()
  const settingsIdentity = resolveSettingsIdentity(sessionId, profileId)
  const identityQuery = settingsIdentity?.query ?? null
  const identityQueryRef = useRef<string | null>(identityQuery)

  // --- TanStack Query hooks ---
  const autonomousQuery = useAutonomousStatus(identityQuery)
  const providersQuery = useProviders(identityQuery)
  const ragStatusQuery = useRagStatus()
  const daemonQuery = useDaemon()
  const agentActivityQuery = useAgentActivity(identityQuery)
  const bootReportQuery = useBootReport()

  // --- Derived state from queries ---
  const autoStatus: AutonomousStatus = autonomousQuery.data ?? { enabled: false }
  const autoLoading = autonomousQuery.isLoading && Boolean(identityQuery)

  const activeProvider: ActiveProvider | null = providersQuery.data?.active
    ? {
        ...providersQuery.data.active,
        executionPool: (providersQuery.data.executionPool as ProviderInfo[] | undefined) ?? undefined,
      }
    : null
  const embeddingStatus: EmbeddingStatus | null = (ragStatusQuery.data?.status as EmbeddingStatus | undefined) ?? null
  const modelLoading = providersQuery.isLoading && Boolean(identityQuery)

  const daemonStatus: DaemonStatus | null = daemonQuery.data
    ? {
        running: daemonQuery.data.running,
        configured: daemonQuery.data.configured,
        intervalMs: daemonQuery.data.intervalMs,
        triggers: (daemonQuery.data.triggers ?? []) as DaemonStatus['triggers'],
        budget: daemonQuery.data.budget,
        approvalQueue: (daemonQuery.data.approvalQueue ?? []) as DaemonStatus['approvalQueue'],
        startupNotices: daemonQuery.data.startupNotices,
      }
    : null
  const daemonLoading = daemonQuery.isLoading

  const bootReport: BootReport | null = (bootReportQuery.data?.bootReport as BootReport | null) ?? null
  const bootLoading = bootReportQuery.isLoading

  // --- Routing data from agent-activity ---
  const routingPresetFromServer = agentActivityQuery.data?.preset
  const routingDecisions: RoutingDecision[] = Array.isArray(agentActivityQuery.data?.routing)
    ? (agentActivityQuery.data.routing as RoutingDecision[]).slice(0, 6)
    : []
  const executionTraces: ExecutionTrace[] = Array.isArray(agentActivityQuery.data?.execution)
    ? (agentActivityQuery.data.execution as ExecutionTrace[]).slice(-6).reverse()
    : []
  const phaseOutcomes: PhaseOutcome[] = Array.isArray(agentActivityQuery.data?.outcomes)
    ? (agentActivityQuery.data.outcomes as PhaseOutcome[]).slice(-6).reverse()
    : []
  const phaseScores: PhaseScore[] = Array.isArray(agentActivityQuery.data?.phaseScores)
    ? (agentActivityQuery.data.phaseScores as PhaseScore[]).slice(0, 6)
    : []
  const runtimeArtifacts: RuntimeArtifact[] = Array.isArray(agentActivityQuery.data?.artifacts)
    ? (agentActivityQuery.data.artifacts as RuntimeArtifact[]).slice(0, 6)
    : []
  const routingLoading = agentActivityQuery.isLoading && Boolean(identityQuery)

  // --- Local state ---
  const [autoToggling, setAutoToggling] = useState(false)
  const [autoDuration, setAutoDuration] = useState(24)
  const [daemonToggling, setDaemonToggling] = useState(false)
  const [routingPreset, setRoutingPreset] = useState<string>('balanced')
  const [routingSwitching, setRoutingSwitching] = useState(false)
  const [voice, setVoice] = useState<VoiceSettings>(loadVoiceSettings)
  const speechInputAvailable = hasSpeechRecognition()
  const speechOutputAvailable = hasSpeechSynthesis()
  const daemonBudgetPercent = daemonStatus ? toPercent(daemonStatus.budget.pct) : 0

  // Sync routing preset from server
  useEffect(() => {
    if (routingPresetFromServer) setRoutingPreset(routingPresetFromServer)
  }, [routingPresetFromServer])

  // Handle identity changes — invalidate queries to force refetch
  useEffect(() => {
    const previousQuery = identityQueryRef.current
    if (!identityQuery) {
      identityQueryRef.current = null
      return
    }

    if (!shouldRefetchIdentityScopedSettings(previousQuery, identityQuery)) {
      identityQueryRef.current = identityQuery
      return
    }

    identityQueryRef.current = identityQuery
    queryClient.invalidateQueries({ queryKey: ['autonomous'] })
    queryClient.invalidateQueries({ queryKey: ['providers'] })
    queryClient.invalidateQueries({ queryKey: ['agent-activity'] })
  }, [identityQuery, queryClient])

  // --- Handlers ---

  const handleAutoToggle = useCallback(async () => {
    if (autoToggling || !settingsIdentity) return
    const nextEnabled = !autoStatus?.enabled
    setAutoToggling(true)

    // Try HTTP first (works without active WS), fall back to WS command
    try {
      const res = await fetch('/api/user/autonomous', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: settingsIdentity.chatId,
          ...(settingsIdentity.profileId ? { userId: settingsIdentity.profileId, conversationId: settingsIdentity.profileId } : {}),
          enabled: nextEnabled,
          hours: nextEnabled ? autoDuration : undefined,
        }),
      })
      if (!res.ok) throw new Error('HTTP failed')
    } catch {
      // Fallback to WS command
      const sent = toggleAutonomous(nextEnabled, nextEnabled ? autoDuration : undefined)
      if (!sent) {
        setAutoToggling(false)
        return
      }
    }

    // Re-fetch after a short delay
    setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ['autonomous'] })
      setAutoToggling(false)
    }, 1500)
  }, [autoStatus?.enabled, autoDuration, autoToggling, settingsIdentity, toggleAutonomous, queryClient])

  const handleDurationChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10)
    if (!isNaN(val) && val >= 1 && val <= 168) {
      setAutoDuration(val)
    }
  }, [])

  const handleDaemonToggle = useCallback(async () => {
    if (daemonToggling || !daemonStatus) return
    setDaemonToggling(true)

    const endpoint = daemonStatus.running ? '/api/daemon/stop' : '/api/daemon/start'
    try {
      const res = await fetch(endpoint, { method: 'POST' })
      if (res.ok) {
        // Re-fetch status after a short delay
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ['daemon'] })
          setDaemonToggling(false)
        }, 1000)
      } else {
        queryClient.invalidateQueries({ queryKey: ['daemon'] })
        setDaemonToggling(false)
      }
    } catch {
      queryClient.invalidateQueries({ queryKey: ['daemon'] })
      setDaemonToggling(false)
    }
  }, [daemonToggling, daemonStatus, queryClient])

  const handleVoiceInputToggle = useCallback(() => {
    setVoice((prev) => {
      const next = { ...prev, inputEnabled: !prev.inputEnabled }
      saveVoiceSettings(next)
      return next
    })
  }, [])

  const handleVoiceOutputToggle = useCallback(() => {
    setVoice((prev) => {
      const next = { ...prev, outputEnabled: !prev.outputEnabled }
      saveVoiceSettings(next)
      return next
    })
  }, [])

  const handlePresetChange = useCallback(async (preset: string) => {
    if (routingSwitching) return
    setRoutingSwitching(true)

    try {
      const res = await fetch('/api/routing/preset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset }),
      })
      if (res.ok) {
        setRoutingPreset(preset)
      }
    } catch {
      // Silently fail — user can retry
    } finally {
      setRoutingSwitching(false)
    }
  }, [routingSwitching])

  // --- Render ---

  return (
    <div className="flex-1 overflow-y-auto p-7 w-full animate-[admin-fade-in_0.3s_ease]">
      <h2>Settings</h2>

      <div className="mb-7">
        <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">Recovery Surface</div>
        {bootLoading ? (
          <div className="flex items-center justify-center text-text-secondary text-[15px]">Loading...</div>
        ) : bootReport ? (
          <>
            <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
              <span className="text-text-secondary">Protected Channels</span>
              <span className="text-text font-semibold">{bootReport.goldenPath.channels.join(', ')}</span>
            </div>
            <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
              <span className="text-text-secondary">Recommended Preset</span>
              <span className="text-text font-semibold">{bootReport.goldenPath.recommendedPreset}</span>
            </div>
            <table className="w-full bg-bg-secondary border border-border rounded-[14px] overflow-hidden [border-spacing:0] [border-collapse:separate]">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Status</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {bootReport.stages.map((stage) => (
                  <tr key={stage.id}>
                    <td>{stage.label}</td>
                    <td>{stage.status}</td>
                    <td>{stage.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="w-full bg-bg-secondary border border-border rounded-[14px] overflow-hidden [border-spacing:0] [border-collapse:separate]">
              <thead>
                <tr>
                  <th>Capability</th>
                  <th>Tier</th>
                  <th>Status</th>
                  <th>Truth</th>
                </tr>
              </thead>
              <tbody>
                {bootReport.capabilities.map((capability) => (
                  <tr key={capability.id}>
                    <td>
                      <div>{capability.name}</div>
                      <div className="text-xs opacity-75 mt-1">{capability.detail}</div>
                    </td>
                    <td>{capability.tier}</td>
                    <td>{capability.status}</td>
                    <td>{capability.truth}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <div className="flex items-center justify-center text-text-secondary text-[15px]">Boot report unavailable.</div>
        )}
      </div>

      {/* ===== Autonomous Mode ===== */}
      <div className="mb-7">
        <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">Autonomous Mode</div>

        {autoLoading ? (
          <div className="flex items-center justify-center text-text-secondary text-[15px]">Loading...</div>
        ) : (
          <>
            <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
              <span className="text-text-secondary">Autonomous Mode</span>
              <button
                className={`settings-toggle ${autoStatus?.enabled ? 'on' : 'off'}`}
                onClick={handleAutoToggle}
                disabled={autoToggling}
                aria-label={autoStatus?.enabled ? 'Disable autonomous mode' : 'Enable autonomous mode'}
              >
                <span className="settings-toggle-knob" />
              </button>
            </div>

            <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
              <span className="text-text-secondary">Status</span>
              <span className="text-text font-semibold">
                <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${autoStatus?.enabled ? 'bg-success shadow-[0_0_6px_var(--color-success)]' : 'bg-text-tertiary'}`} />{' '}
                {autoStatus?.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>

            {autoStatus?.enabled && autoStatus.remainingMs != null && (
              <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
                <span className="text-text-secondary">Time Remaining</span>
                <span className="text-text font-semibold">{formatRemaining(autoStatus.remainingMs)}</span>
              </div>
            )}

            <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
              <span className="text-text-secondary">Duration (hours)</span>
              <input
                className="w-20 px-2.5 py-1.5 border border-border rounded-lg bg-input-bg text-text font-mono text-[13px] text-center outline-none transition-all duration-150 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-glow)] disabled:opacity-50 disabled:cursor-not-allowed"
                type="number"
                min={1}
                max={168}
                value={autoDuration}
                onChange={handleDurationChange}
                disabled={autoStatus?.enabled}
              />
            </div>

            <div className="text-xs text-text-tertiary leading-relaxed mt-2.5 mb-1">
              When enabled, the agent will operate without asking for confirmation. Duration: 1-168 hours.
            </div>
          </>
        )}
      </div>

      {/* ===== Daemon Mode ===== */}
      <div className="mb-7">
        <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">Daemon Mode</div>

        {daemonLoading ? (
          <div className="flex items-center justify-center text-text-secondary text-[15px]">Loading...</div>
        ) : (
          <>
            <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
              <span className="text-text-secondary">Daemon</span>
              <span className="text-text font-semibold flex items-center gap-3">
                <span>
                  <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${daemonStatus?.running ? 'bg-success shadow-[0_0_6px_var(--color-success)]' : 'bg-text-tertiary'}`} />{' '}
                  {daemonStatus?.running ? 'Running' : daemonStatus?.configured ? 'Stopped' : 'Not Configured'}
                </span>
                <button
                  className={`settings-toggle ${daemonStatus?.running ? 'on' : 'off'}`}
                  onClick={handleDaemonToggle}
                  disabled={daemonToggling || !daemonStatus?.configured}
                  aria-label={daemonStatus?.running ? 'Stop daemon' : 'Start daemon'}
                  title={!daemonStatus?.configured ? 'Enable Daemon Mode in Setup Wizard or start with --daemon flag' : undefined}
                >
                  <span className="settings-toggle-knob" />
                </button>
              </span>
            </div>

            {daemonStatus?.running ? (
              <>
                {/* Budget */}
                <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
                  <span className="text-text-secondary">Budget</span>
                  <span className="text-text font-semibold">
                    ${daemonStatus.budget.usedUsd.toFixed(2)} / ${daemonStatus.budget.limitUsd.toFixed(2)} used ({daemonBudgetPercent.toFixed(1)}%)
                  </span>
                </div>
                <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
                  <span className="text-text-secondary" />
                  <div style={{ flex: 1, maxWidth: 260 }}>
                    <div
                      className="settings-budget-bar"
                      style={{
                        height: 6,
                        borderRadius: 3,
                        background: 'var(--bg-tertiary)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.min(daemonBudgetPercent, 100)}%`,
                          height: '100%',
                          borderRadius: 3,
                          background: daemonBudgetPercent >= 90
                            ? 'var(--error)'
                            : daemonBudgetPercent >= 70
                              ? 'var(--warning)'
                              : 'var(--success)',
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </div>
                  </div>
                </div>

                {/* Triggers */}
                <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
                  <span className="text-text-secondary">Triggers</span>
                  <span className="text-text font-semibold">
                    {daemonStatus.triggers.length} active trigger{daemonStatus.triggers.length !== 1 ? 's' : ''}
                  </span>
                </div>

                {/* Approval Queue */}
                {daemonStatus.approvalQueue.length > 0 && (
                  <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
                    <span className="text-text-secondary">Approval Queue</span>
                    <span className="text-text font-semibold text-warning">
                      {daemonStatus.approvalQueue.length} pending approval{daemonStatus.approvalQueue.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                )}

                {/* Interval */}
                {daemonStatus.intervalMs != null && (
                  <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
                    <span className="text-text-secondary">Heartbeat Interval</span>
                    <span className="text-text font-semibold">
                      {daemonStatus.intervalMs >= 60000
                        ? `${Math.round(daemonStatus.intervalMs / 60000)}m`
                        : `${Math.round(daemonStatus.intervalMs / 1000)}s`}
                    </span>
                  </div>
                )}

                {daemonStatus.startupNotices && daemonStatus.startupNotices.length > 0 && (
                  <div className="mt-4 grid gap-2">
                    <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
                      <span className="text-text-secondary">Startup Notices</span>
                      <span className="text-text font-semibold">{daemonStatus.startupNotices.length}</span>
                    </div>
                    {daemonStatus.startupNotices.map((notice, index) => (
                      <div
                        key={`${notice}-${index}`}
                        className="relative bg-bg-secondary border border-border rounded-xl p-3.5 text-left cursor-default font-[inherit] transition-all duration-150"
                      >
                        <div className="text-xs text-text-tertiary leading-relaxed mt-2.5 mb-1">
                          {notice}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="text-xs text-text-tertiary leading-relaxed mt-2.5 mb-1">
                  Daemon mode enables autonomous background execution with scheduled triggers,
                  file watchers, and webhooks.
                </div>
                {daemonStatus?.startupNotices && daemonStatus.startupNotices.length > 0 && (
                  <div className="mt-4 grid gap-2">
                    {daemonStatus.startupNotices.map((notice, index) => (
                      <div
                        key={`${notice}-${index}`}
                        className="relative bg-bg-secondary border border-border rounded-xl p-3.5 text-left cursor-default font-[inherit] transition-all duration-150"
                      >
                        <div className="text-xs text-text-tertiary leading-relaxed mt-2.5 mb-1">
                          {notice}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="text-xs text-text-tertiary leading-relaxed mt-2.5 mb-1">
                  Enable Daemon Mode in the Setup Wizard or start with <code className="text-[11px] text-text-secondary">--daemon</code> flag.
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* ===== Routing ===== */}
      <div className="mb-7">
        <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">Strada Execution Policy</div>

        {routingLoading ? (
          <div className="flex items-center justify-center text-text-secondary text-[15px]">Loading...</div>
        ) : (
          <>
            <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
              <span className="text-text-secondary">Routing Preset</span>
              <div>
                {(['budget', 'balanced', 'performance'] as const).map(p => (
                  <button
                    key={p}
                    className={`settings-provider-card ${p === routingPreset ? 'active' : ''}`}
                                       onClick={() => p !== routingPreset && handlePresetChange(p)}
                    disabled={routingSwitching || p === routingPreset}
                  >
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="text-xs text-text-tertiary leading-relaxed mt-2.5 mb-1">
              Strada remains the control plane. This preset biases how Strada assigns planning,
              execution, clarification review, review, and synthesis work across available providers.
              Configure with <code className="text-[11px] text-text-secondary">ROUTING_PRESET</code> or <code className="text-[11px] text-text-secondary">/routing preset</code> command.
            </div>

            {routingDecisions.length > 0 && (
              <div>
                <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
                  <span className="text-text-secondary">Recent Worker Decisions</span>
                  <span className="text-text font-semibold">{routingDecisions.length}</span>
                </div>
                <div>
                  {routingDecisions.map((decision, index) => (
                    <div
                      key={`${decision.provider}-${decision.timestamp}-${index}`}
                      className="relative bg-bg-secondary border border-border rounded-xl p-3.5 text-left cursor-pointer font-[inherit] transition-all duration-150 hover:border-border-hover hover:-translate-y-px hover:shadow-[var(--shadow-sm)] disabled:cursor-default"
                      style={{
                        textAlign: 'left',
                        padding: '12px 14px',
                        cursor: 'default',
                      }}
                    >
                      <div className="flex justify-between gap-3 mb-1.5">
                        <div className="text-sm font-semibold text-text mb-1.5">
                          {decision.task.type}{' -> '}{decision.provider}
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          {formatDecisionTime(decision.timestamp)}
                        </div>
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        <span className="text-[11px] font-mono text-text-tertiary">{decision.task.complexity}</span>
                        <span className="text-[11px] font-mono text-text-secondary">{decision.task.criticality}</span>
                      </div>
                      {decision.catalogSignal && (
                        <div className="flex gap-2 flex-wrap">
                          <span className="text-[11px] font-mono text-text-tertiary">
                            freshness {decision.catalogSignal.freshnessScore.toFixed(2)}
                          </span>
                          <span className="text-[11px] font-mono text-text-secondary">
                            alignment {decision.catalogSignal.alignmentScore.toFixed(2)}
                          </span>
                          {decision.catalogSignal.stale && (
                            <span className="text-[11px] font-mono text-text-secondary">stale catalog</span>
                          )}
                        </div>
                      )}
                      <div className="text-xs text-text-tertiary leading-relaxed mt-2.5 mb-1">
                        {decision.reason}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {executionTraces.length > 0 && (
              <div>
                <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
                  <span className="text-text-secondary">Recent Runtime Execution</span>
                  <span className="text-text font-semibold">{executionTraces.length}</span>
                </div>
                <div>
                  {executionTraces.map((trace, index) => (
                    <div
                      key={`${trace.provider}-${trace.phase}-${trace.role}-${trace.timestamp}-${index}`}
                      className="relative bg-bg-secondary border border-border rounded-xl p-3.5 text-left cursor-pointer font-[inherit] transition-all duration-150 hover:border-border-hover hover:-translate-y-px hover:shadow-[var(--shadow-sm)] disabled:cursor-default"
                      style={{
                        textAlign: 'left',
                        padding: '12px 14px',
                        cursor: 'default',
                      }}
                    >
                      <div className="flex justify-between gap-3 mb-1.5">
                        <div className="text-sm font-semibold text-text mb-1.5">
                          {trace.phase}{' / '}{trace.role}{' -> '}{trace.provider}
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          {formatDecisionTime(trace.timestamp)}
                        </div>
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        <span className="text-[11px] font-mono text-text-tertiary">{trace.source}</span>
                        {trace.model && (
                          <span className="text-[11px] font-mono text-text-secondary">{trace.model}</span>
                        )}
                      </div>
                      <div className="text-xs text-text-tertiary leading-relaxed mt-2.5 mb-1">
                        {trace.reason}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {phaseOutcomes.length > 0 && (
              <div>
                <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
                  <span className="text-text-secondary">Recent Phase Outcomes</span>
                  <span className="text-text font-semibold">{phaseOutcomes.length}</span>
                </div>
                <div>
                  {phaseOutcomes.map((outcome, index) => (
                    <div
                      key={`${outcome.provider}-${outcome.phase}-${outcome.role}-${outcome.timestamp}-${index}`}
                      className="relative bg-bg-secondary border border-border rounded-xl p-3.5 text-left cursor-pointer font-[inherit] transition-all duration-150 hover:border-border-hover hover:-translate-y-px hover:shadow-[var(--shadow-sm)] disabled:cursor-default"
                      style={{
                        textAlign: 'left',
                        padding: '12px 14px',
                        cursor: 'default',
                      }}
                    >
                      <div className="flex justify-between gap-3 mb-1.5">
                        <div className="text-sm font-semibold text-text mb-1.5">
                          {outcome.phase}{' / '}{outcome.role}{' -> '}{outcome.provider}
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          {formatDecisionTime(outcome.timestamp)}
                        </div>
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        <span className="text-[11px] font-mono text-text-tertiary">{outcome.status}</span>
                        <span className="text-[11px] font-mono text-text-secondary">{outcome.source}</span>
                        {outcome.model && (
                          <span className="text-[11px] font-mono text-text-secondary">{outcome.model}</span>
                        )}
                      </div>
                      <div className="text-xs text-text-tertiary leading-relaxed mt-2.5 mb-1">
                        {outcome.reason}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {phaseScores.length > 0 && (
              <div>
                <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
                  <span className="text-text-secondary">Adaptive Phase Scores</span>
                  <span className="text-text font-semibold">{phaseScores.length}</span>
                </div>
                <div>
                  {phaseScores.map((score, index) => (
                    <div
                      key={`${score.provider}-${score.phase}-${score.role}-${index}`}
                      className="relative bg-bg-secondary border border-border rounded-xl p-3.5 text-left cursor-default font-[inherit] transition-all duration-150"
                    >
                      <div className="flex justify-between gap-3 mb-1.5">
                        <div className="text-sm font-semibold text-text mb-1.5">
                          {score.phase}{' / '}{score.role}{' -> '}{score.provider}
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          {score.score.toFixed(2)} score
                        </div>
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        <span className="text-[11px] font-mono text-text-tertiary">samples {score.sampleSize}</span>
                        <span className="text-[11px] font-mono text-text-secondary">verifier {score.verifierCleanRate.toFixed(2)}</span>
                        <span className="text-[11px] font-mono text-text-secondary">rollback {score.rollbackRate.toFixed(2)}</span>
                        <span className="text-[11px] font-mono text-text-secondary">retry {score.avgRetryCount.toFixed(2)}</span>
                        <span className="text-[11px] font-mono text-text-secondary">cost {Math.round(score.avgTokenCost)}</span>
                        <span className="text-[11px] font-mono text-text-secondary">repeats {score.repeatedFailureCount}</span>
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        <span className="text-[11px] font-mono text-text-secondary">approved {score.approvedCount}</span>
                        <span className="text-[11px] font-mono text-text-secondary">continued {score.continuedCount}</span>
                        <span className="text-[11px] font-mono text-text-secondary">replanned {score.replannedCount}</span>
                        <span className="text-[11px] font-mono text-text-secondary">failed {score.failedCount}</span>
                      </div>
                      <div className="text-xs text-text-tertiary leading-relaxed mt-2.5 mb-1">
                        {score.latestReason}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {runtimeArtifacts.length > 0 && (
              <div>
                <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
                  <span className="text-text-secondary">Runtime Self-Improvement</span>
                  <span className="text-text font-semibold">{runtimeArtifacts.length}</span>
                </div>
                <div>
                  {runtimeArtifacts.map((artifact) => (
                    <div
                      key={artifact.id}
                      className="relative bg-bg-secondary border border-border rounded-xl p-3.5 text-left cursor-default font-[inherit] transition-all duration-150"
                    >
                      <div className="flex justify-between gap-3 mb-1.5">
                        <div className="text-sm font-semibold text-text mb-1.5">
                          {artifact.kind}{' -> '}{artifact.name}
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          {artifact.state}
                        </div>
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        <span className="text-[11px] font-mono text-text-tertiary">samples {artifact.stats.shadowSampleCount}</span>
                        <span className="text-[11px] font-mono text-text-secondary">active uses {artifact.stats.activeUseCount}</span>
                        <span className="text-[11px] font-mono text-text-secondary">clean {artifact.stats.cleanCount}</span>
                        <span className="text-[11px] font-mono text-text-secondary">retry {artifact.stats.retryCount}</span>
                        <span className="text-[11px] font-mono text-text-secondary">failed {artifact.stats.failureCount}</span>
                        <span className="text-[11px] font-mono text-text-secondary">blocker {artifact.stats.blockerCount}</span>
                        <span className="text-[11px] font-mono text-text-secondary">{artifact.projectWorldFingerprint ? 'project-scoped' : 'general'}</span>
                      </div>
                      <div className="text-xs text-text-tertiary leading-relaxed mt-2.5 mb-1">
                        {artifact.description}
                      </div>
                      {artifact.lastStateReason ? (
                        <div className="text-xs text-text-tertiary leading-relaxed mt-2.5 mb-1">
                          {artifact.lastStateReason}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ===== Model Selection ===== */}
      <div className="mb-7">
        <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">Primary Worker</div>

        {modelLoading ? (
          <div className="flex items-center justify-center text-text-secondary text-[15px]">Loading providers...</div>
        ) : (
          <>
            {activeProvider && (
              <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
                <span className="text-text-secondary">Primary Execution Worker</span>
                <span className="text-text font-semibold">
                  {activeProvider.providerName}
                  {activeProvider.isDefault && (
                    <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-md bg-accent-glow text-accent uppercase tracking-[0.03em] ml-2 align-middle">Default</span>
                  )}
                </span>
              </div>
            )}

            {activeProvider?.model && (
              <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
                <span className="text-text-secondary">Worker Model</span>
                <span className="text-text font-semibold font-mono text-xs">
                  {activeProvider.model}
                </span>
              </div>
            )}

            {activeProvider?.selectionMode && (
              <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
                <span className="text-text-secondary">Selection Mode</span>
                <span className="text-text font-semibold">
                  {activeProvider.selectionMode === 'strada-primary-worker'
                    ? 'Strada primary worker'
                    : activeProvider.selectionMode}
                </span>
              </div>
            )}

            {activeProvider?.executionPool && activeProvider.executionPool.length > 0 && (
              <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
                <span className="text-text-secondary">Execution Pool</span>
                <span className="text-text font-semibold">
                  {activeProvider.executionPool.map((provider) => provider.name).join(', ')}
                </span>
              </div>
            )}

            {embeddingStatus && (
              <>
                <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
                  <span className="text-text-secondary">Embedding Provider</span>
                  <span className="text-text font-semibold font-mono text-xs">
                    {embeddingStatus.resolvedProviderName ?? 'Hash fallback'}
                  </span>
                </div>

                <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
                  <span className="text-text-secondary">Embedding Resolution</span>
                  <span className="text-text font-semibold">
                    {embeddingStatus.resolutionSource ?? embeddingStatus.state}
                  </span>
                </div>

                <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
                  <span className="text-text-secondary">Embedding Dimensions</span>
                  <span className="text-text font-semibold font-mono text-xs">
                    {embeddingStatus.activeDimensions ?? embeddingStatus.configuredDimensions ?? 'n/a'}
                  </span>
                </div>

                <div className="text-xs text-text-tertiary leading-relaxed mt-2.5 mb-1">
                  {embeddingStatus.ragEnabled
                    ? `RAG is ${embeddingStatus.state === 'active' ? 'active' : 'degraded'}. Configured embedding provider: ${embeddingStatus.configuredProvider}.`
                    : embeddingStatus.state === 'active'
                      ? 'RAG is disabled, but embeddings remain active for memory and learning.'
                      : 'RAG is disabled.'}
                  {embeddingStatus.notice ? ` ${embeddingStatus.notice}` : ''}
                </div>
              </>
            )}

            {activeProvider?.executionPolicyNote && (
              <div className="text-xs text-text-tertiary leading-relaxed mt-2.5 mb-1">
                {activeProvider.executionPolicyNote}
              </div>
            )}

            <div className="text-xs text-text-tertiary leading-relaxed mt-2.5 mb-1">
              Changing this does not turn Strada into a direct provider chat. It only changes the
              main worker Strada prefers for implementation-heavy turns.
            </div>

            <PrimaryWorkerSelector />
          </>
        )}
      </div>

      {/* ===== Voice Mode ===== */}
      <div className="mb-7">
        <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">Voice Mode</div>

        <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
          <div>
            <span className="text-text-secondary">Voice Input</span>
            {!speechInputAvailable && (
              <div className="text-xs text-text-tertiary leading-relaxed mt-2.5 mb-1">
                Speech recognition is not supported in this browser.
              </div>
            )}
          </div>
          <button
            className={`settings-toggle ${voice.inputEnabled ? 'on' : 'off'}`}
            onClick={handleVoiceInputToggle}
            disabled={!speechInputAvailable}
            aria-label={voice.inputEnabled ? 'Disable voice input' : 'Enable voice input'}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>

        <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
          <div>
            <span className="text-text-secondary">Voice Output (Auto-read Responses)</span>
            {!speechOutputAvailable && (
              <div className="text-xs text-text-tertiary leading-relaxed mt-2.5 mb-1">
                Speech synthesis is not supported in this browser.
              </div>
            )}
          </div>
          <button
            className={`settings-toggle ${voice.outputEnabled ? 'on' : 'off'}`}
            onClick={handleVoiceOutputToggle}
            disabled={!speechOutputAvailable}
            aria-label={voice.outputEnabled ? 'Disable voice output' : 'Enable voice output'}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>

        <div className="text-xs text-text-tertiary leading-relaxed mt-2.5 mb-1">
          Voice settings are stored locally in your browser and do not affect other sessions.
        </div>
      </div>
    </div>
  )
}
