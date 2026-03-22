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
    <div className="admin-page">
      <h2>Settings</h2>

      <div className="admin-section">
        <div className="admin-section-title">Recovery Surface</div>
        {bootLoading ? (
          <div className="page-loading" style={{ height: 80 }}>Loading...</div>
        ) : bootReport ? (
          <>
            <div className="admin-stat-row">
              <span className="admin-stat-label">Protected Channels</span>
              <span className="admin-stat-value">{bootReport.goldenPath.channels.join(', ')}</span>
            </div>
            <div className="admin-stat-row">
              <span className="admin-stat-label">Recommended Preset</span>
              <span className="admin-stat-value">{bootReport.goldenPath.recommendedPreset}</span>
            </div>
            <table className="admin-table" style={{ marginTop: 16 }}>
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
            <table className="admin-table" style={{ marginTop: 16 }}>
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
                      <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>{capability.detail}</div>
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
          <div className="page-loading" style={{ height: 80 }}>Boot report unavailable.</div>
        )}
      </div>

      {/* ===== Autonomous Mode ===== */}
      <div className="admin-section">
        <div className="admin-section-title">Autonomous Mode</div>

        {autoLoading ? (
          <div className="page-loading" style={{ height: 80 }}>Loading...</div>
        ) : (
          <>
            <div className="admin-stat-row">
              <span className="admin-stat-label">Autonomous Mode</span>
              <button
                className={`settings-toggle ${autoStatus?.enabled ? 'on' : 'off'}`}
                onClick={handleAutoToggle}
                disabled={autoToggling}
                aria-label={autoStatus?.enabled ? 'Disable autonomous mode' : 'Enable autonomous mode'}
              >
                <span className="settings-toggle-knob" />
              </button>
            </div>

            <div className="admin-stat-row">
              <span className="admin-stat-label">Status</span>
              <span className="admin-stat-value">
                <span className={`status-dot-inline ${autoStatus?.enabled ? 'ok' : 'off'}`} />{' '}
                {autoStatus?.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>

            {autoStatus?.enabled && autoStatus.remainingMs != null && (
              <div className="admin-stat-row">
                <span className="admin-stat-label">Time Remaining</span>
                <span className="admin-stat-value">{formatRemaining(autoStatus.remainingMs)}</span>
              </div>
            )}

            <div className="admin-stat-row">
              <span className="admin-stat-label">Duration (hours)</span>
              <input
                className="settings-number-input"
                type="number"
                min={1}
                max={168}
                value={autoDuration}
                onChange={handleDurationChange}
                disabled={autoStatus?.enabled}
              />
            </div>

            <div className="settings-hint">
              When enabled, the agent will operate without asking for confirmation. Duration: 1-168 hours.
            </div>
          </>
        )}
      </div>

      {/* ===== Daemon Mode ===== */}
      <div className="admin-section">
        <div className="admin-section-title">Daemon Mode</div>

        {daemonLoading ? (
          <div className="page-loading" style={{ height: 80 }}>Loading...</div>
        ) : (
          <>
            <div className="admin-stat-row">
              <span className="admin-stat-label">Daemon</span>
              <span className="admin-stat-value" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span>
                  <span className={`status-dot-inline ${daemonStatus?.running ? 'ok' : 'off'}`} />{' '}
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
                <div className="admin-stat-row">
                  <span className="admin-stat-label">Budget</span>
                  <span className="admin-stat-value">
                    ${daemonStatus.budget.usedUsd.toFixed(2)} / ${daemonStatus.budget.limitUsd.toFixed(2)} used ({daemonBudgetPercent.toFixed(1)}%)
                  </span>
                </div>
                <div className="admin-stat-row">
                  <span className="admin-stat-label" />
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
                <div className="admin-stat-row">
                  <span className="admin-stat-label">Triggers</span>
                  <span className="admin-stat-value">
                    {daemonStatus.triggers.length} active trigger{daemonStatus.triggers.length !== 1 ? 's' : ''}
                  </span>
                </div>

                {/* Approval Queue */}
                {daemonStatus.approvalQueue.length > 0 && (
                  <div className="admin-stat-row">
                    <span className="admin-stat-label">Approval Queue</span>
                    <span className="admin-stat-value" style={{ color: 'var(--warning)' }}>
                      {daemonStatus.approvalQueue.length} pending approval{daemonStatus.approvalQueue.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                )}

                {/* Interval */}
                {daemonStatus.intervalMs != null && (
                  <div className="admin-stat-row">
                    <span className="admin-stat-label">Heartbeat Interval</span>
                    <span className="admin-stat-value">
                      {daemonStatus.intervalMs >= 60000
                        ? `${Math.round(daemonStatus.intervalMs / 60000)}m`
                        : `${Math.round(daemonStatus.intervalMs / 1000)}s`}
                    </span>
                  </div>
                )}

                {daemonStatus.startupNotices && daemonStatus.startupNotices.length > 0 && (
                  <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
                    <div className="admin-stat-row" style={{ marginBottom: 0 }}>
                      <span className="admin-stat-label">Startup Notices</span>
                      <span className="admin-stat-value">{daemonStatus.startupNotices.length}</span>
                    </div>
                    {daemonStatus.startupNotices.map((notice, index) => (
                      <div
                        key={`${notice}-${index}`}
                        className="settings-provider-card"
                        style={{ textAlign: 'left', padding: '12px 14px', cursor: 'default' }}
                      >
                        <div className="settings-hint" style={{ margin: 0 }}>
                          {notice}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="settings-hint" style={{ marginTop: 8 }}>
                  Daemon mode enables autonomous background execution with scheduled triggers,
                  file watchers, and webhooks.
                </div>
                {daemonStatus?.startupNotices && daemonStatus.startupNotices.length > 0 && (
                  <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
                    {daemonStatus.startupNotices.map((notice, index) => (
                      <div
                        key={`${notice}-${index}`}
                        className="settings-provider-card"
                        style={{ textAlign: 'left', padding: '12px 14px', cursor: 'default' }}
                      >
                        <div className="settings-hint" style={{ margin: 0 }}>
                          {notice}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="settings-hint" style={{ marginTop: 6 }}>
                  Enable Daemon Mode in the Setup Wizard or start with <code style={{ fontSize: 11, color: 'var(--text-secondary)' }}>--daemon</code> flag.
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* ===== Routing ===== */}
      <div className="admin-section">
        <div className="admin-section-title">Strada Execution Policy</div>

        {routingLoading ? (
          <div className="page-loading" style={{ height: 80 }}>Loading...</div>
        ) : (
          <>
            <div className="admin-stat-row">
              <span className="admin-stat-label">Routing Preset</span>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['budget', 'balanced', 'performance'] as const).map(p => (
                  <button
                    key={p}
                    className={`settings-provider-card ${p === routingPreset ? 'active' : ''}`}
                    style={{ padding: '6px 14px', fontSize: 13, minWidth: 0 }}
                    onClick={() => p !== routingPreset && handlePresetChange(p)}
                    disabled={routingSwitching || p === routingPreset}
                  >
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-hint">
              Strada remains the control plane. This preset biases how Strada assigns planning,
              execution, clarification review, review, and synthesis work across available providers.
              Configure with <code style={{ fontSize: 11, color: 'var(--text-secondary)' }}>ROUTING_PRESET</code> or <code style={{ fontSize: 11, color: 'var(--text-secondary)' }}>/routing preset</code> command.
            </div>

            {routingDecisions.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="admin-stat-row" style={{ marginBottom: 10 }}>
                  <span className="admin-stat-label">Recent Worker Decisions</span>
                  <span className="admin-stat-value">{routingDecisions.length}</span>
                </div>
                <div style={{ display: 'grid', gap: 10 }}>
                  {routingDecisions.map((decision, index) => (
                    <div
                      key={`${decision.provider}-${decision.timestamp}-${index}`}
                      className="settings-provider-card"
                      style={{
                        textAlign: 'left',
                        padding: '12px 14px',
                        cursor: 'default',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                        <div className="settings-provider-name" style={{ fontSize: 14 }}>
                          {decision.task.type}{' -> '}{decision.provider}
                        </div>
                        <div className="settings-provider-meta" style={{ fontSize: 12 }}>
                          {formatDecisionTime(decision.timestamp)}
                        </div>
                      </div>
                      <div className="settings-provider-meta" style={{ marginBottom: 4 }}>
                        <span className="settings-provider-id">{decision.task.complexity}</span>
                        <span className="settings-provider-model">{decision.task.criticality}</span>
                      </div>
                      {decision.catalogSignal && (
                        <div className="settings-provider-meta" style={{ marginBottom: 4 }}>
                          <span className="settings-provider-id">
                            freshness {decision.catalogSignal.freshnessScore.toFixed(2)}
                          </span>
                          <span className="settings-provider-model">
                            alignment {decision.catalogSignal.alignmentScore.toFixed(2)}
                          </span>
                          {decision.catalogSignal.stale && (
                            <span className="settings-provider-model">stale catalog</span>
                          )}
                        </div>
                      )}
                      <div className="settings-hint" style={{ margin: 0 }}>
                        {decision.reason}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {executionTraces.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="admin-stat-row" style={{ marginBottom: 10 }}>
                  <span className="admin-stat-label">Recent Runtime Execution</span>
                  <span className="admin-stat-value">{executionTraces.length}</span>
                </div>
                <div style={{ display: 'grid', gap: 10 }}>
                  {executionTraces.map((trace, index) => (
                    <div
                      key={`${trace.provider}-${trace.phase}-${trace.role}-${trace.timestamp}-${index}`}
                      className="settings-provider-card"
                      style={{
                        textAlign: 'left',
                        padding: '12px 14px',
                        cursor: 'default',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                        <div className="settings-provider-name" style={{ fontSize: 14 }}>
                          {trace.phase}{' / '}{trace.role}{' -> '}{trace.provider}
                        </div>
                        <div className="settings-provider-meta" style={{ fontSize: 12 }}>
                          {formatDecisionTime(trace.timestamp)}
                        </div>
                      </div>
                      <div className="settings-provider-meta" style={{ marginBottom: 4 }}>
                        <span className="settings-provider-id">{trace.source}</span>
                        {trace.model && (
                          <span className="settings-provider-model">{trace.model}</span>
                        )}
                      </div>
                      <div className="settings-hint" style={{ margin: 0 }}>
                        {trace.reason}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {phaseOutcomes.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="admin-stat-row" style={{ marginBottom: 10 }}>
                  <span className="admin-stat-label">Recent Phase Outcomes</span>
                  <span className="admin-stat-value">{phaseOutcomes.length}</span>
                </div>
                <div style={{ display: 'grid', gap: 10 }}>
                  {phaseOutcomes.map((outcome, index) => (
                    <div
                      key={`${outcome.provider}-${outcome.phase}-${outcome.role}-${outcome.timestamp}-${index}`}
                      className="settings-provider-card"
                      style={{
                        textAlign: 'left',
                        padding: '12px 14px',
                        cursor: 'default',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                        <div className="settings-provider-name" style={{ fontSize: 14 }}>
                          {outcome.phase}{' / '}{outcome.role}{' -> '}{outcome.provider}
                        </div>
                        <div className="settings-provider-meta" style={{ fontSize: 12 }}>
                          {formatDecisionTime(outcome.timestamp)}
                        </div>
                      </div>
                      <div className="settings-provider-meta" style={{ marginBottom: 4 }}>
                        <span className="settings-provider-id">{outcome.status}</span>
                        <span className="settings-provider-model">{outcome.source}</span>
                        {outcome.model && (
                          <span className="settings-provider-model">{outcome.model}</span>
                        )}
                      </div>
                      <div className="settings-hint" style={{ margin: 0 }}>
                        {outcome.reason}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {phaseScores.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="admin-stat-row" style={{ marginBottom: 10 }}>
                  <span className="admin-stat-label">Adaptive Phase Scores</span>
                  <span className="admin-stat-value">{phaseScores.length}</span>
                </div>
                <div style={{ display: 'grid', gap: 10 }}>
                  {phaseScores.map((score, index) => (
                    <div
                      key={`${score.provider}-${score.phase}-${score.role}-${index}`}
                      className="settings-provider-card"
                      style={{ textAlign: 'left', padding: '12px 14px', cursor: 'default' }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                        <div className="settings-provider-name" style={{ fontSize: 14 }}>
                          {score.phase}{' / '}{score.role}{' -> '}{score.provider}
                        </div>
                        <div className="settings-provider-meta" style={{ fontSize: 12 }}>
                          {score.score.toFixed(2)} score
                        </div>
                      </div>
                      <div className="settings-provider-meta" style={{ marginBottom: 4 }}>
                        <span className="settings-provider-id">samples {score.sampleSize}</span>
                        <span className="settings-provider-model">verifier {score.verifierCleanRate.toFixed(2)}</span>
                        <span className="settings-provider-model">rollback {score.rollbackRate.toFixed(2)}</span>
                        <span className="settings-provider-model">retry {score.avgRetryCount.toFixed(2)}</span>
                        <span className="settings-provider-model">cost {Math.round(score.avgTokenCost)}</span>
                        <span className="settings-provider-model">repeats {score.repeatedFailureCount}</span>
                      </div>
                      <div className="settings-provider-meta" style={{ marginBottom: 4 }}>
                        <span className="settings-provider-model">approved {score.approvedCount}</span>
                        <span className="settings-provider-model">continued {score.continuedCount}</span>
                        <span className="settings-provider-model">replanned {score.replannedCount}</span>
                        <span className="settings-provider-model">failed {score.failedCount}</span>
                      </div>
                      <div className="settings-hint" style={{ margin: 0 }}>
                        {score.latestReason}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {runtimeArtifacts.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="admin-stat-row" style={{ marginBottom: 10 }}>
                  <span className="admin-stat-label">Runtime Self-Improvement</span>
                  <span className="admin-stat-value">{runtimeArtifacts.length}</span>
                </div>
                <div style={{ display: 'grid', gap: 10 }}>
                  {runtimeArtifacts.map((artifact) => (
                    <div
                      key={artifact.id}
                      className="settings-provider-card"
                      style={{ textAlign: 'left', padding: '12px 14px', cursor: 'default' }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                        <div className="settings-provider-name" style={{ fontSize: 14 }}>
                          {artifact.kind}{' -> '}{artifact.name}
                        </div>
                        <div className="settings-provider-meta" style={{ fontSize: 12 }}>
                          {artifact.state}
                        </div>
                      </div>
                      <div className="settings-provider-meta" style={{ marginBottom: 4 }}>
                        <span className="settings-provider-id">samples {artifact.stats.shadowSampleCount}</span>
                        <span className="settings-provider-model">active uses {artifact.stats.activeUseCount}</span>
                        <span className="settings-provider-model">clean {artifact.stats.cleanCount}</span>
                        <span className="settings-provider-model">retry {artifact.stats.retryCount}</span>
                        <span className="settings-provider-model">failed {artifact.stats.failureCount}</span>
                        <span className="settings-provider-model">blocker {artifact.stats.blockerCount}</span>
                        <span className="settings-provider-model">{artifact.projectWorldFingerprint ? 'project-scoped' : 'general'}</span>
                      </div>
                      <div className="settings-hint" style={{ marginBottom: 4 }}>
                        {artifact.description}
                      </div>
                      {artifact.lastStateReason ? (
                        <div className="settings-hint" style={{ margin: 0 }}>
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
      <div className="admin-section">
        <div className="admin-section-title">Primary Worker</div>

        {modelLoading ? (
          <div className="page-loading" style={{ height: 80 }}>Loading providers...</div>
        ) : (
          <>
            {activeProvider && (
              <div className="admin-stat-row" style={{ marginBottom: 16 }}>
                <span className="admin-stat-label">Primary Execution Worker</span>
                <span className="admin-stat-value">
                  {activeProvider.providerName}
                  {activeProvider.isDefault && (
                    <span className="settings-badge">Default</span>
                  )}
                </span>
              </div>
            )}

            {activeProvider?.model && (
              <div className="admin-stat-row" style={{ marginBottom: 16 }}>
                <span className="admin-stat-label">Worker Model</span>
                <span className="admin-stat-value admin-card-value mono">
                  {activeProvider.model}
                </span>
              </div>
            )}

            {activeProvider?.selectionMode && (
              <div className="admin-stat-row" style={{ marginBottom: 16 }}>
                <span className="admin-stat-label">Selection Mode</span>
                <span className="admin-stat-value">
                  {activeProvider.selectionMode === 'strada-primary-worker'
                    ? 'Strada primary worker'
                    : activeProvider.selectionMode}
                </span>
              </div>
            )}

            {activeProvider?.executionPool && activeProvider.executionPool.length > 0 && (
              <div className="admin-stat-row" style={{ marginBottom: 16 }}>
                <span className="admin-stat-label">Execution Pool</span>
                <span className="admin-stat-value admin-card-value">
                  {activeProvider.executionPool.map((provider) => provider.name).join(', ')}
                </span>
              </div>
            )}

            {embeddingStatus && (
              <>
                <div className="admin-stat-row" style={{ marginBottom: 16 }}>
                  <span className="admin-stat-label">Embedding Provider</span>
                  <span className="admin-stat-value admin-card-value mono">
                    {embeddingStatus.resolvedProviderName ?? 'Hash fallback'}
                  </span>
                </div>

                <div className="admin-stat-row" style={{ marginBottom: 16 }}>
                  <span className="admin-stat-label">Embedding Resolution</span>
                  <span className="admin-stat-value">
                    {embeddingStatus.resolutionSource ?? embeddingStatus.state}
                  </span>
                </div>

                <div className="admin-stat-row" style={{ marginBottom: 16 }}>
                  <span className="admin-stat-label">Embedding Dimensions</span>
                  <span className="admin-stat-value admin-card-value mono">
                    {embeddingStatus.activeDimensions ?? embeddingStatus.configuredDimensions ?? 'n/a'}
                  </span>
                </div>

                <div className="settings-hint" style={{ marginTop: -4, marginBottom: 16 }}>
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
              <div className="settings-hint" style={{ marginBottom: 16 }}>
                {activeProvider.executionPolicyNote}
              </div>
            )}

            <div className="settings-hint" style={{ marginBottom: 16 }}>
              Changing this does not turn Strada into a direct provider chat. It only changes the
              main worker Strada prefers for implementation-heavy turns.
            </div>

            <PrimaryWorkerSelector />
          </>
        )}
      </div>

      {/* ===== Voice Mode ===== */}
      <div className="admin-section">
        <div className="admin-section-title">Voice Mode</div>

        <div className="admin-stat-row">
          <div>
            <span className="admin-stat-label">Voice Input</span>
            {!speechInputAvailable && (
              <div className="settings-hint" style={{ marginTop: 4, marginBottom: 0 }}>
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

        <div className="admin-stat-row">
          <div>
            <span className="admin-stat-label">Voice Output (Auto-read Responses)</span>
            {!speechOutputAvailable && (
              <div className="settings-hint" style={{ marginTop: 4, marginBottom: 0 }}>
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

        <div className="settings-hint">
          Voice settings are stored locally in your browser and do not affect other sessions.
        </div>
      </div>
    </div>
  )
}
