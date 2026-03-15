import { useState, useRef, useEffect, useCallback } from 'react'
import type { SaveStatus } from '../types/setup'
import { PRESETS, PROVIDER_MAP, CHANNELS } from '../types/setup-constants'

export function useSetupWizard() {
  const [step, setStep] = useState(1)
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null)
  const [checkedProviders, setCheckedProviders] = useState<Set<string>>(new Set(['claude']))
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>({})
  const [projectPath, setProjectPathState] = useState('')
  const [pathValid, setPathValid] = useState<boolean | null>(null)
  const [pathError, setPathError] = useState<string | null>(null)
  const [channel, setChannelState] = useState('web')
  const [channelConfig, setChannelConfig] = useState<Record<string, string>>({})
  const [language, setLanguageState] = useState('en')
  const [ragEnabled, setRagEnabledState] = useState(true)
  const [embeddingProvider, setEmbeddingProviderState] = useState('auto')
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)

  const csrfTokenRef = useRef<string>('')
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mountedRef = useRef(true)

  // Fetch CSRF token on mount
  useEffect(() => {
    mountedRef.current = true
    fetch('/api/setup/csrf')
      .then((res) => res.json())
      .then((data) => {
        csrfTokenRef.current = data.token ?? ''
      })
      .catch(() => {
        // CSRF fetch failure is non-fatal; save() will fail if token is missing
      })

    return () => {
      mountedRef.current = false
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
      }
    }
  }, [])

  const validateCurrentStep = useCallback((): boolean => {
    switch (step) {
      case 2: {
        if (checkedProviders.size === 0) return false
        return Array.from(checkedProviders).some((id) =>
          id === 'ollama' || (providerKeys[id] ?? '').trim().length > 0,
        )
      }
      case 3:
        return projectPath.trim().length > 0
      default:
        return true
    }
  }, [step, checkedProviders, providerKeys, projectPath])

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

  const save = useCallback(async () => {
    setSaveStatus('saving')
    setSaveError(null)

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

    // Build PROVIDER_CHAIN from checked providers
    const chain = Array.from(checkedProviders)
    config.PROVIDER_CHAIN = chain.join(',')

    // Add provider API keys
    for (const id of chain) {
      const provider = PROVIDER_MAP[id]
      if (provider?.envKey) {
        const key = (providerKeys[id] ?? '').trim()
        if (key) {
          config[provider.envKey] = key
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

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Save failed (${res.status})`)
      }

      // Poll for readiness — the wizard server shuts down and the main app
      // boots on the same port, so expect connection errors during the gap.
      setSaveStatus('polling')
      let attempts = 0
      const maxAttempts = 40 // 40 x 2s = 80s total timeout

      pollTimerRef.current = setInterval(async () => {
        if (!mountedRef.current) {
          if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null }
          return
        }
        attempts++
        try {
          const healthRes = await fetch('/health')
          if (!healthRes.ok) return // non-200, keep polling
          const healthData = await healthRes.json()
          if (healthData.status === 'ok') {
            if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null }
            if (!mountedRef.current) return
            setSaveStatus('success')
            setTimeout(() => {
              localStorage.setItem('strada-firstRun', '1')
              window.location.href = '/'
            }, 500)
          }
        } catch {
          // Connection refused during server restart — expected, keep polling
        }

        if (attempts >= maxAttempts) {
          if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null }
          if (!mountedRef.current) return
          setSaveStatus('error')
          setSaveError('Server did not become ready in time. Please refresh and try again.')
        }
      }, 2000)
    } catch (err) {
      setSaveStatus('error')
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    }
  }, [projectPath, ragEnabled, embeddingProvider, language, channel, selectedPreset, checkedProviders, providerKeys, channelConfig])

  return {
    // State
    step,
    selectedPreset,
    checkedProviders,
    providerKeys,
    projectPath,
    pathValid,
    pathError,
    channel,
    channelConfig,
    language,
    ragEnabled,
    embeddingProvider,
    saveStatus,
    saveError,

    // Methods
    nextStep,
    prevStep,
    goToStep,
    selectPreset,
    toggleProvider,
    setProviderKey,
    setProjectPath,
    validatePath,
    setChannel,
    setChannelConfigField,
    setLanguage,
    setRagEnabled,
    setEmbeddingProvider,
    save,
    validateCurrentStep,
  }
}
