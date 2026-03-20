import { useState, useRef, useEffect, useCallback } from 'react'
import type { ProviderPreflightFailure, SaveStatus, SetupSaveResponse, SetupStatusResponse } from '../types/setup'
import { PRESETS, PROVIDER_MAP, CHANNELS, EMBEDDING_CAPABLE } from '../types/setup-constants'
import { buildPostSetupBootstrap, FIRST_RUN_STORAGE_KEY, POST_SETUP_BOOTSTRAP_STORAGE_KEY } from './useWebSocket'
import { isSetupStatusResponse } from '../../../src/common/setup-contract.ts'
import { deriveSetupBootstrapView, transitionSetupStatus } from '../../../src/common/setup-state.ts'

const SETUP_AVAILABILITY_MAX_ATTEMPTS = 25
const SETUP_AVAILABILITY_RETRY_MS = 1000
const SETUP_BOOTSTRAP_POLL_MS = 1000
const SETUP_BOOTSTRAP_MAX_ATTEMPTS = 80

export function hasUsableResponseCredential(
  providerId: string,
  providerKeys: Record<string, string>,
  providerAuthModes: Record<string, string>,
): boolean {
  if (providerId === 'ollama') return true
  if (providerId === 'openai' && providerAuthModes[providerId] === 'chatgpt-subscription') {
    return true
  }
  return (providerKeys[providerId] ?? '').trim().length > 0
}

export function hasUsableEmbeddingCredential(
  providerId: string,
  providerKeys: Record<string, string>,
): boolean {
  if (providerId === 'ollama') return true
  return (providerKeys[providerId] ?? '').trim().length > 0
}

export function hasAutoEmbeddingCandidate(
  checkedProviders: Set<string>,
  providerKeys: Record<string, string>,
): boolean {
  return Array.from(checkedProviders).some((providerId) =>
    EMBEDDING_CAPABLE.has(providerId) && hasUsableEmbeddingCredential(providerId, providerKeys),
  )
}

export function getSetupReviewBlockingReason(
  ragEnabled: boolean,
  embeddingProvider: string,
  checkedProviders: Set<string>,
  providerKeys: Record<string, string>,
  providerAuthModes: Record<string, string>,
): string | null {
  if (!ragEnabled) return null

  if (embeddingProvider === 'auto') {
    return hasAutoEmbeddingCandidate(checkedProviders, providerKeys)
      ? null
      : 'RAG is enabled, but no embedding-capable provider is currently configured. Choose Gemini, OpenAI, Mistral, Together, Fireworks, Qwen, or Ollama for embeddings, or disable RAG before saving.'
  }

  if (hasUsableEmbeddingCredential(embeddingProvider, providerKeys)) {
    return null
  }

  if (embeddingProvider === 'openai' && providerAuthModes.openai === 'chatgpt-subscription') {
    return 'OpenAI conversation subscription does not cover embeddings. Add an OpenAI API key for embeddings or choose another embedding provider.'
  }

  const providerName = PROVIDER_MAP[embeddingProvider]?.name ?? embeddingProvider
  return `${providerName} embeddings need a usable API key before setup can be saved.`
}

export type SetupSurfaceProbe =
  | { kind: 'available'; token: string }
  | { kind: 'redirect' }
  | { kind: 'retry' }

function formatProviderIssues(failures: ProviderPreflightFailure[] | undefined): string | null {
  if (!failures || failures.length === 0) return null
  return failures.map((failure) => `${failure.providerName}: ${failure.detail}`).join(' ')
}

export async function readSetupBootstrapStatus(
  fetchImpl: typeof fetch = fetch,
): Promise<SetupStatusResponse | null> {
  try {
    const res = await fetchImpl('/api/setup/status', { cache: 'no-store' })
    if (!res.ok) {
      return null
    }

    const data = await res.json().catch(() => null)
    if (!isSetupStatusResponse(data)) {
      return null
    }

    return data
  } catch {
    return null
  }
}

export async function probeSetupSurface(
  fetchImpl: typeof fetch = fetch,
): Promise<SetupSurfaceProbe> {
  try {
    const res = await fetchImpl('/api/setup/csrf', { cache: 'no-store' })
    if (res.ok) {
      const data = await res.json().catch(() => ({}))
      const token = typeof data.token === 'string' ? data.token : ''
      if (token) {
        return { kind: 'available', token }
      }
    }

    if (res.status === 409) {
      const data = await res.json().catch(() => null)
      if (data && typeof data === 'object' && data.handoff === true) {
        return { kind: 'retry' }
      }
    }
  } catch {
    // setup server may still be booting or handing off
  }

  try {
    const healthRes = await fetchImpl('/health', { cache: 'no-store' })
    if (healthRes.ok) {
      const healthData = await healthRes.json().catch(() => null)
      if (healthData && typeof healthData === 'object' && healthData.status === 'ok') {
        return { kind: 'redirect' }
      }
    }
  } catch {
    // main app may not be ready yet
  }

  return { kind: 'retry' }
}

export function useSetupWizard() {
  const [setupAvailability, setSetupAvailability] = useState<'checking' | 'available' | 'unavailable'>('checking')
  const [setupUnavailableReason, setSetupUnavailableReason] = useState<string | null>(null)
  const [step, setStep] = useState(1)
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null)
  const [checkedProviders, setCheckedProviders] = useState<Set<string>>(new Set(['claude']))
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>({})
  const [providerAuthModes, setProviderAuthModes] = useState<Record<string, string>>({ openai: 'api-key' })
  const [projectPath, setProjectPathState] = useState('')
  const [pathValid, setPathValid] = useState<boolean | null>(null)
  const [pathError, setPathError] = useState<string | null>(null)
  const [channel, setChannelState] = useState('web')
  const [channelConfig, setChannelConfig] = useState<Record<string, string>>({})
  const [language, setLanguageState] = useState('en')
  const [ragEnabled, setRagEnabledState] = useState(true)
  const [embeddingProvider, setEmbeddingProviderState] = useState('auto')
  const [daemonEnabled, setDaemonEnabledState] = useState(false)
  const [autonomyEnabled, setAutonomyEnabledState] = useState(false)
  const [autonomyHours, setAutonomyHoursState] = useState(4)
  const [daemonBudget, setDaemonBudgetState] = useState(1.0)
  const [saveCommitted, setSaveCommitted] = useState(false)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveWarning, setSaveWarning] = useState<string | null>(null)
  const [bootstrapDetail, setBootstrapDetail] = useState<string | null>(null)
  const [readyUrl, setReadyUrl] = useState<string | null>(typeof window !== 'undefined' ? `${window.location.origin}/` : null)

  const csrfTokenRef = useRef<string>('')
  const readyUrlRef = useRef<string | null>(typeof window !== 'undefined' ? `${window.location.origin}/` : null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const availabilityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const reviewBlockingReason = getSetupReviewBlockingReason(
    ragEnabled,
    embeddingProvider,
    checkedProviders,
    providerKeys,
    providerAuthModes,
  )

  const rememberReadyUrl = useCallback((nextReadyUrl?: string | null) => {
    if (typeof nextReadyUrl !== 'string') return
    const normalized = nextReadyUrl.trim()
    if (!normalized) return
    readyUrlRef.current = normalized
    setReadyUrl(normalized)
  }, [])

  // Fetch CSRF token on mount
  useEffect(() => {
    mountedRef.current = true
    let attempts = 0

    const checkAvailability = async () => {
      const result = await probeSetupSurface(fetch)
      if (!mountedRef.current) return

      if (result.kind === 'available') {
        csrfTokenRef.current = result.token
        setSetupAvailability('available')
        setSetupUnavailableReason(null)
        return
      }

      if (result.kind === 'redirect') {
        window.location.replace('/')
        return
      }

      attempts += 1
      if (attempts < SETUP_AVAILABILITY_MAX_ATTEMPTS) {
        availabilityTimerRef.current = setTimeout(() => {
          void checkAvailability()
        }, SETUP_AVAILABILITY_RETRY_MS)
        return
      }

      setSetupAvailability('unavailable')
      setSetupUnavailableReason(
        'Setup wizard is not reachable right now. If setup already finished, Strada may still be handing off to the main app. Wait a moment and refresh, or run `strada setup` to try again.',
      )
    }

    void checkAvailability()

    return () => {
      mountedRef.current = false
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
      }
      if (availabilityTimerRef.current) {
        clearTimeout(availabilityTimerRef.current)
      }
    }
  }, [])

  const validateCurrentStep = useCallback((): boolean => {
    switch (step) {
      case 2: {
        if (checkedProviders.size === 0) return false
        return Array.from(checkedProviders).every((id) =>
          hasUsableResponseCredential(id, providerKeys, providerAuthModes),
        )
      }
      case 4: {
        return true
      }
      case 3:
        return projectPath.trim().length > 0
      default:
        return true
    }
  }, [step, checkedProviders, providerKeys, providerAuthModes, projectPath])

  const nextStep = useCallback(() => {
    if (validateCurrentStep() && step < 5) {
      setStep((s) => s + 1)
    }
  }, [step, validateCurrentStep])

  const prevStep = useCallback(() => {
    if (step > 1) {
      setStep((s) => s - 1)
    }
  }, [step])

  const goToStep = useCallback((n: number) => {
    if (n >= 1 && n <= 5) {
      setStep(n)
    }
  }, [])

  const selectPreset = useCallback((id: string) => {
    setSelectedPreset(id)
    const preset = PRESETS.find((p) => p.id === id)
    if (preset) {
      setCheckedProviders(new Set(preset.providers))
    }
  }, [])

  const toggleProvider = useCallback((id: string) => {
    setCheckedProviders((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
    setSelectedPreset(null)
  }, [])

  const setProviderKey = useCallback((id: string, key: string) => {
    setProviderKeys((prev) => ({ ...prev, [id]: key }))
  }, [])

  const setProviderAuthMode = useCallback((id: string, mode: string) => {
    setProviderAuthModes((prev) => ({ ...prev, [id]: mode }))
  }, [])

  const setProjectPath = useCallback((path: string) => {
    setProjectPathState(path)
    setPathValid(null)
    setPathError(null)
  }, [])

  const validatePath = useCallback(async () => {
    if (!projectPath.trim()) {
      setPathValid(false)
      setPathError('Path is required')
      return
    }
    try {
      const res = await fetch(`/api/setup/validate-path?path=${encodeURIComponent(projectPath)}`)
      const data = await res.json()
      setPathValid(data.valid ?? false)
      setPathError(data.error ?? null)
    } catch {
      setPathValid(false)
      setPathError('Failed to validate path')
    }
  }, [projectPath])

  const setChannel = useCallback((id: string) => {
    setChannelState(id)
  }, [])

  const setChannelConfigField = useCallback((envKey: string, value: string) => {
    // Only accept keys that belong to the active channel's known fields
    const channelDef = CHANNELS.find((c) => c.id === channel)
    const validKeys = new Set(channelDef?.fields.map((f) => f.envKey) ?? [])
    if (!validKeys.has(envKey)) return
    setChannelConfig((prev) => ({ ...prev, [envKey]: value }))
  }, [channel])

  const setLanguage = useCallback((code: string) => {
    setLanguageState(code)
  }, [])

  const setRagEnabled = useCallback((enabled: boolean) => {
    setRagEnabledState(enabled)
  }, [])

  const setEmbeddingProvider = useCallback((provider: string) => {
    setEmbeddingProviderState(provider)
  }, [])

  const setDaemonEnabled = useCallback((enabled: boolean) => {
    setDaemonEnabledState(enabled)
  }, [])

  const setAutonomyEnabled = useCallback((enabled: boolean) => {
    setAutonomyEnabledState(enabled)
  }, [])

  const setAutonomyHours = useCallback((hours: number) => {
    setAutonomyHoursState(hours)
  }, [])

  const setDaemonBudget = useCallback((budget: number) => {
    setDaemonBudgetState(budget)
  }, [])

  const applySetupBootstrapStatus = useCallback((status: SetupStatusResponse) => {
    rememberReadyUrl(status.readyUrl)
    const bootstrapView = deriveSetupBootstrapView(status)
    if (!bootstrapView) {
      return false
    }

    setSaveStatus(bootstrapView.saveStatus)
    setBootstrapDetail(bootstrapView.detail)

    if (bootstrapView.saveStatus === 'error') {
      setSaveError(bootstrapView.detail)
      return true
    }

    setSaveError(null)

    if (bootstrapView.saveStatus === 'success') {
      const nextLocation = bootstrapView.readyUrl || readyUrlRef.current || (typeof window !== 'undefined' ? `${window.location.origin}/` : '/')
      setTimeout(() => {
        window.location.replace(nextLocation)
      }, 250)
    }

    return true
  }, [rememberReadyUrl])

  const save = useCallback(async () => {
    setSaveStatus('saving')
    setSaveError(null)
    setSaveWarning(null)
    setSaveCommitted(false)
    setBootstrapDetail(null)
    rememberReadyUrl(typeof window !== 'undefined' ? `${window.location.origin}/` : null)

    if (reviewBlockingReason) {
      setSaveStatus('error')
      setSaveError(reviewBlockingReason)
      return
    }

    // Build config object
    const config: Record<string, string> = {
      UNITY_PROJECT_PATH: projectPath,
      RAG_ENABLED: ragEnabled ? 'true' : 'false',
      LANGUAGE_PREFERENCE: language,
      _channel: channel,
    }

    if (embeddingProvider && embeddingProvider !== 'auto') {
      config.EMBEDDING_PROVIDER = embeddingProvider
    }

    if (selectedPreset) {
      config.SYSTEM_PRESET = selectedPreset
    }

    if (daemonEnabled) {
      config.STRADA_DAEMON_ENABLED = 'true'
      config.STRADA_DAEMON_DAILY_BUDGET = String(daemonBudget)
    }
    if (autonomyEnabled) {
      config.AUTONOMOUS_DEFAULT_ENABLED = 'true'
      config.AUTONOMOUS_DEFAULT_HOURS = String(autonomyHours)
    }

    // Build PROVIDER_CHAIN from checked providers
    const chain = Array.from(checkedProviders)
    config.PROVIDER_CHAIN = chain.join(',')

    // Add provider API keys
    for (const id of chain) {
      const provider = PROVIDER_MAP[id]
      if (id === 'openai') {
        config.OPENAI_AUTH_MODE = providerAuthModes.openai === 'chatgpt-subscription'
          ? 'chatgpt-subscription'
          : 'api-key'
      }
      if (provider?.envKey) {
        const key = (providerKeys[id] ?? '').trim()
        if (key && !(id === 'openai' && providerAuthModes.openai === 'chatgpt-subscription')) {
          config[provider.envKey] = key
        }
      }
    }

    if (ragEnabled && embeddingProvider && embeddingProvider !== 'auto') {
      const embeddingProviderDef = PROVIDER_MAP[embeddingProvider]
      if (embeddingProviderDef?.envKey) {
        const embeddingKey = (providerKeys[embeddingProvider] ?? '').trim()
        if (embeddingKey) {
          config[embeddingProviderDef.envKey] = embeddingKey
        }
      }
    }

    // Add channel-specific config
    for (const [key, value] of Object.entries(channelConfig)) {
      if (value.trim()) {
        config[key] = value.trim()
      }
    }

    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfTokenRef.current,
        },
        body: JSON.stringify(config),
      })

      const body = await res.json().catch(() => ({})) as SetupSaveResponse
      rememberReadyUrl(body.readyUrl)
      if (!res.ok) {
        if (res.status === 409 && body && typeof body === 'object' && body.handoff === true) {
          setSaveCommitted(true)
          applySetupBootstrapStatus(transitionSetupStatus(
            { state: 'saved' },
            {
              type: 'bootstrap_starting',
              readyUrl: body.readyUrl ?? readyUrlRef.current ?? undefined,
              detail: typeof body.error === 'string'
                ? body.error
                : 'Configuration already saved. Strada is still starting.',
            },
          ))
        } else {
          const providerFailureMessage = formatProviderIssues(body.providerFailures)
          throw new Error(providerFailureMessage ?? body.error ?? `Save failed (${res.status})`)
        }
      } else {
        const providerWarningMessage = formatProviderIssues(body.providerWarnings)
        localStorage.setItem(FIRST_RUN_STORAGE_KEY, '1')
        localStorage.setItem(
          POST_SETUP_BOOTSTRAP_STORAGE_KEY,
          JSON.stringify(buildPostSetupBootstrap(autonomyEnabled, autonomyHours)),
        )

        setSaveCommitted(true)
        setSaveWarning(providerWarningMessage)
        applySetupBootstrapStatus(transitionSetupStatus(
          { state: 'collecting' },
          {
            type: 'config_saved',
            readyUrl: body.readyUrl ?? readyUrlRef.current ?? undefined,
            detail: 'Configuration accepted. Starting Strada on this same URL.',
            providerWarnings: body.providerWarnings,
          },
        ))
      }

      let attempts = 0

      pollTimerRef.current = setInterval(async () => {
        if (!mountedRef.current) {
          if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null }
          return
        }
        attempts++

        try {
          const setupStatus = await readSetupBootstrapStatus(fetch)
          if (setupStatus) {
            rememberReadyUrl(setupStatus.readyUrl)
            const providerWarningMessage = formatProviderIssues(setupStatus.providerWarnings)
            if (providerWarningMessage) {
              setSaveWarning(providerWarningMessage)
            }

            if (applySetupBootstrapStatus(setupStatus)) {
              if (setupStatus.state === 'failed' || setupStatus.state === 'ready') {
                if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null }
              }
              return
            }
          }

          const healthRes = await fetch('/health', { cache: 'no-store' })
          if (!healthRes.ok) return
          const healthData = await healthRes.json().catch(() => null)
          if (healthData.status === 'ok') {
            if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null }
            if (!mountedRef.current) return
            applySetupBootstrapStatus(transitionSetupStatus(
              { state: 'booting' },
              { type: 'bootstrap_ready', readyUrl: readyUrlRef.current ?? `${window.location.origin}/` },
            ))
          }
        } catch {
          // Same-port handoff can briefly reject requests while the app replaces the wizard.
        }

        if (attempts >= SETUP_BOOTSTRAP_MAX_ATTEMPTS) {
          if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null }
          if (!mountedRef.current) return
          const fallbackReadyUrl = readyUrlRef.current
          applySetupBootstrapStatus(transitionSetupStatus(
            { state: 'booting' },
            {
              type: 'bootstrap_failed',
              detail: fallbackReadyUrl
                ? `Configuration was saved, but Strada did not expose a ready or failed bootstrap state in time. Open ${fallbackReadyUrl} directly, or re-open setup and inspect the startup error.`
                : 'Configuration was saved, but Strada did not expose a ready or failed bootstrap state in time. Re-open setup and inspect the startup error.',
            },
          ))
        }
      }, SETUP_BOOTSTRAP_POLL_MS)
    } catch (err) {
      setSaveStatus('error')
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    }
  }, [projectPath, ragEnabled, embeddingProvider, language, channel, selectedPreset, checkedProviders, providerKeys, providerAuthModes, channelConfig, daemonEnabled, autonomyEnabled, autonomyHours, daemonBudget, reviewBlockingReason, applySetupBootstrapStatus, rememberReadyUrl])

  return {
    // State
    setupAvailability,
    setupUnavailableReason,
    step,
    selectedPreset,
    checkedProviders,
    providerKeys,
    providerAuthModes,
    projectPath,
    pathValid,
    pathError,
    channel,
    channelConfig,
    language,
    ragEnabled,
    embeddingProvider,
    daemonEnabled,
    autonomyEnabled,
    autonomyHours,
    daemonBudget,
    saveStatus,
    saveError,
    saveWarning,
    bootstrapDetail,
    readyUrl,
    saveCommitted,
    reviewBlockingReason,
    canSave: !reviewBlockingReason && !(saveCommitted && saveStatus === 'error'),

    // Methods
    nextStep,
    prevStep,
    goToStep,
    selectPreset,
    toggleProvider,
    setProviderKey,
    setProviderAuthMode,
    setProjectPath,
    validatePath,
    setChannel,
    setChannelConfigField,
    setLanguage,
    setRagEnabled,
    setEmbeddingProvider,
    setDaemonEnabled,
    setAutonomyEnabled,
    setAutonomyHours,
    setDaemonBudget,
    save,
    validateCurrentStep,
  }
}
