import { useState, useCallback } from 'react'
import { useWS } from '../hooks/useWS'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { fetchJson, settledValue } from '../utils/api'

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
  selectionMode?: 'strada-primary-worker'
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

interface VoiceSettings {
  inputEnabled: boolean
  outputEnabled: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VOICE_STORAGE_KEY = 'strada-voice-settings'

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
  const { switchProvider, toggleAutonomous, sessionId, profileId } = useWS()
  const chatId = sessionId ?? 'default'
  const identityQuery = new URLSearchParams({
    chatId,
    ...(profileId ? { userId: profileId, conversationId: profileId } : {}),
  }).toString()

  // --- Autonomous Mode ---
  const [autoStatus, setAutoStatus] = useState<AutonomousStatus | null>(null)
  const [autoLoading, setAutoLoading] = useState(true)
  const [autoToggling, setAutoToggling] = useState(false)
  const [autoDuration, setAutoDuration] = useState(24)

  // --- Model Selection ---
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [activeProvider, setActiveProvider] = useState<ActiveProvider | null>(null)
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null)
  const [modelLoading, setModelLoading] = useState(true)
  const [switching, setSwitching] = useState(false)

  // --- Daemon Mode ---
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatus | null>(null)
  const [daemonLoading, setDaemonLoading] = useState(true)
  const [daemonToggling, setDaemonToggling] = useState(false)

  // --- Routing Preset ---
  const [routingPreset, setRoutingPreset] = useState<string>('balanced')
  const [routingDecisions, setRoutingDecisions] = useState<RoutingDecision[]>([])
  const [executionTraces, setExecutionTraces] = useState<ExecutionTrace[]>([])
  const [routingLoading, setRoutingLoading] = useState(true)
  const [routingSwitching, setRoutingSwitching] = useState(false)

  // --- Voice Mode ---
  const [voice, setVoice] = useState<VoiceSettings>(loadVoiceSettings)
  const speechInputAvailable = hasSpeechRecognition()
  const speechOutputAvailable = hasSpeechSynthesis()
  const daemonBudgetPercent = daemonStatus ? toPercent(daemonStatus.budget.pct) : 0

  // --- Fetch autonomous status ---
  const fetchAutonomous = useCallback(() => {
    fetchJson<AutonomousStatus>(`/api/user/autonomous?${identityQuery}`)
      .then((data) => {
        setAutoStatus(data ?? { enabled: false })
        setAutoLoading(false)
      })
      .catch(() => {
        setAutoStatus({ enabled: false })
        setAutoLoading(false)
      })
  }, [identityQuery])

  // --- Fetch providers ---
  const fetchProviders = useCallback(() => {
    Promise.allSettled([
      fetchJson<{ providers: ProviderInfo[] }>('/api/providers/available'),
      fetchJson<{ active: ActiveProvider | null; executionPool?: ProviderInfo[] | null }>(`/api/providers/active?${identityQuery}`),
      fetchJson<{ status: EmbeddingStatus }>('/api/rag/status'),
    ]).then((results) => {
      const [availResult, activeResult, embeddingResult] = results
      const availData = settledValue(availResult)
      const activeData = settledValue(activeResult)
      const embeddingData = settledValue(embeddingResult)
      if (availData?.providers) setProviders(availData.providers)
      if (activeData?.active) {
        setActiveProvider({
          ...activeData.active,
          executionPool: activeData.executionPool ?? undefined,
        })
      }
      if (embeddingData?.status) setEmbeddingStatus(embeddingData.status)
      setModelLoading(false)
      if (!availData && !activeData && !embeddingData) {
        setProviders([])
      }
    }).catch(() => {
      setModelLoading(false)
    })
  }, [identityQuery])

  // --- Fetch routing preset ---
  const fetchRouting = useCallback(() => {
    fetchJson<{ routing: RoutingDecision[]; execution?: ExecutionTrace[]; preset?: string }>(`/api/agent-activity?${identityQuery}`)
      .then((data) => {
        if (data?.preset) setRoutingPreset(data.preset)
        setRoutingDecisions(Array.isArray(data?.routing) ? data.routing.slice(0, 6) : [])
        setExecutionTraces(Array.isArray(data?.execution) ? data.execution.slice(-6).reverse() : [])
        setRoutingLoading(false)
      })
      .catch(() => {
        setRoutingDecisions([])
        setExecutionTraces([])
        setRoutingLoading(false)
      })
  }, [identityQuery])

  // --- Fetch daemon status ---
  const fetchDaemon = useCallback(() => {
    fetchJson<DaemonStatus>('/api/daemon')
      .then((data) => {
        setDaemonStatus(data ?? { running: false, triggers: [], budget: { usedUsd: 0, limitUsd: 0, pct: 0 }, approvalQueue: [] })
        setDaemonLoading(false)
      })
      .catch(() => {
        setDaemonStatus({ running: false, triggers: [], budget: { usedUsd: 0, limitUsd: 0, pct: 0 }, approvalQueue: [] })
        setDaemonLoading(false)
      })
  }, [])

  useAutoRefresh(fetchAutonomous, { intervalMs: 30000 })
  useAutoRefresh(fetchProviders, { intervalMs: 30000 })
  useAutoRefresh(fetchDaemon, { intervalMs: 10000 })
  useAutoRefresh(fetchRouting, { intervalMs: 30000 })

  // --- Handlers ---

  const handleAutoToggle = useCallback(async () => {
    if (autoToggling) return
    const nextEnabled = !autoStatus?.enabled
    setAutoToggling(true)

    // Try HTTP first (works without active WS), fall back to WS command
    try {
      const res = await fetch('/api/user/autonomous', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId,
          ...(profileId ? { userId: profileId, conversationId: profileId } : {}),
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

    // Optimistically update, then re-fetch after a short delay
    setAutoStatus({
      enabled: nextEnabled,
      expiresAt: nextEnabled ? Date.now() + autoDuration * 3600000 : undefined,
      remainingMs: nextEnabled ? autoDuration * 3600000 : undefined,
    })

    setTimeout(() => {
      fetchAutonomous()
      setAutoToggling(false)
    }, 1500)
  }, [autoStatus?.enabled, autoDuration, autoToggling, chatId, profileId, toggleAutonomous, fetchAutonomous])

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
          fetchDaemon()
          setDaemonToggling(false)
        }, 1000)
      } else {
        fetchDaemon()
        setDaemonToggling(false)
      }
    } catch {
      fetchDaemon()
      setDaemonToggling(false)
    }
  }, [daemonToggling, daemonStatus, fetchDaemon])

  const handleProviderSwitch = useCallback((providerName: string) => {
    if (switching) return
    setSwitching(true)

    const sent = switchProvider(providerName)
    if (!sent) {
      setSwitching(false)
      return
    }

    // Optimistically update active display
    const matched = providers.find((p) => p.name === providerName)
    if (matched) {
      setActiveProvider({
        providerName: matched.name,
        model: matched.defaultModel,
        isDefault: false,
        selectionMode: 'strada-primary-worker',
        executionPolicyNote: activeProvider?.executionPolicyNote,
      })
    }

    setTimeout(() => {
      fetchProviders()
      setSwitching(false)
    }, 1500)
  }, [activeProvider?.executionPolicyNote, switching, switchProvider, providers, fetchProviders])

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

            {providers.length > 0 ? (
              <div className="settings-provider-grid">
                {providers.map((p) => {
                  const isActive = activeProvider?.providerName === p.name
                  return (
                    <button
                      key={p.name}
                      className={`settings-provider-card ${isActive ? 'active' : ''}`}
                      onClick={() => !isActive && handleProviderSwitch(p.name)}
                      disabled={isActive || switching}
                    >
                      <div className="settings-provider-name">{p.label}</div>
                      <div className="settings-provider-meta">
                        <span className="settings-provider-id">{p.name}</span>
                        <span className="settings-provider-model">{p.defaultModel}</span>
                      </div>
                      {isActive && <span className="settings-provider-active-tag">Primary</span>}
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="page-empty" style={{ height: 100 }}>
                <p>No providers available. Check your API key configuration.</p>
              </div>
            )}
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
