import { useState, useEffect, useCallback } from 'react'
import { useWS } from '../contexts/WebSocketContext'

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

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const { switchProvider, toggleAutonomous, sessionId } = useWS()
  const chatId = sessionId ?? 'default'

  // --- Autonomous Mode ---
  const [autoStatus, setAutoStatus] = useState<AutonomousStatus | null>(null)
  const [autoLoading, setAutoLoading] = useState(true)
  const [autoToggling, setAutoToggling] = useState(false)
  const [autoDuration, setAutoDuration] = useState(24)

  // --- Model Selection ---
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [activeProvider, setActiveProvider] = useState<ActiveProvider | null>(null)
  const [modelLoading, setModelLoading] = useState(true)
  const [switching, setSwitching] = useState(false)

  // --- Voice Mode ---
  const [voice, setVoice] = useState<VoiceSettings>(loadVoiceSettings)
  const speechInputAvailable = hasSpeechRecognition()
  const speechOutputAvailable = hasSpeechSynthesis()

  // --- Fetch autonomous status ---
  const fetchAutonomous = useCallback(() => {
    fetchJson<AutonomousStatus>(`/api/user/autonomous?chatId=${encodeURIComponent(chatId)}`)
      .then((data) => {
        setAutoStatus(data ?? { enabled: false })
        setAutoLoading(false)
      })
      .catch(() => {
        setAutoStatus({ enabled: false })
        setAutoLoading(false)
      })
  }, [chatId])

  // --- Fetch providers ---
  const fetchProviders = useCallback(() => {
    Promise.all([
      fetchJson<{ providers: ProviderInfo[] }>('/api/providers/available'),
      fetchJson<{ active: ActiveProvider | null }>(`/api/providers/active?chatId=${encodeURIComponent(chatId)}`),
    ]).then(([availData, activeData]) => {
      if (availData?.providers) setProviders(availData.providers)
      if (activeData?.active) setActiveProvider(activeData.active)
      setModelLoading(false)
    }).catch(() => {
      setModelLoading(false)
    })
  }, [chatId])

  useEffect(() => {
    fetchAutonomous()
    fetchProviders()
  }, [fetchAutonomous, fetchProviders])

  // Refresh autonomous remaining time every 30s when active
  useEffect(() => {
    if (!autoStatus?.enabled) return
    const interval = setInterval(fetchAutonomous, 30000)
    return () => clearInterval(interval)
  }, [autoStatus?.enabled, fetchAutonomous])

  // --- Handlers ---

  const handleAutoToggle = useCallback(() => {
    if (autoToggling) return
    const nextEnabled = !autoStatus?.enabled
    setAutoToggling(true)

    const sent = toggleAutonomous(nextEnabled, nextEnabled ? autoDuration : undefined)
    if (!sent) {
      setAutoToggling(false)
      return
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
  }, [autoStatus?.enabled, autoDuration, autoToggling, toggleAutonomous, fetchAutonomous])

  const handleDurationChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10)
    if (!isNaN(val) && val >= 1 && val <= 168) {
      setAutoDuration(val)
    }
  }, [])

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
      })
    }

    setTimeout(() => {
      fetchProviders()
      setSwitching(false)
    }, 1500)
  }, [switching, switchProvider, providers, fetchProviders])

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

      {/* ===== Model Selection ===== */}
      <div className="admin-section">
        <div className="admin-section-title">Model Selection</div>

        {modelLoading ? (
          <div className="page-loading" style={{ height: 80 }}>Loading providers...</div>
        ) : (
          <>
            {activeProvider && (
              <div className="admin-stat-row" style={{ marginBottom: 16 }}>
                <span className="admin-stat-label">Active Provider</span>
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
                <span className="admin-stat-label">Model</span>
                <span className="admin-stat-value admin-card-value mono">
                  {activeProvider.model}
                </span>
              </div>
            )}

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
                      {isActive && <span className="settings-provider-active-tag">Active</span>}
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
