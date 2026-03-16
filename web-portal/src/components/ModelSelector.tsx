import { useCallback, useEffect, useRef, useState } from 'react'
import { useWS } from '../contexts/WebSocketContext'

interface ProviderInfo {
  name: string
  configured: boolean
  models?: string[]
  activeModel?: string
}

interface ActiveInfo {
  provider: string
  model?: string
}

export default function ModelSelector() {
  const { switchProvider, sessionId } = useWS()
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [active, setActive] = useState<ActiveInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const modelsCacheRef = useRef<ProviderInfo[] | null>(null)

  // Fetch available providers (lightweight, no model listing)
  const fetchProviders = useCallback(async () => {
    try {
      const chatId = sessionId || 'default'
      const [availRes, activeRes] = await Promise.all([
        fetch('/api/providers/available'),
        fetch(`/api/providers/active?chatId=${encodeURIComponent(chatId)}`),
      ])

      if (availRes.ok) {
        const data = await availRes.json()
        setProviders(
          (data.providers as ProviderInfo[]).filter((p) => p.configured),
        )
      }

      if (activeRes.ok) {
        const data = await activeRes.json()
        setActive(data.active ?? null)
      }
    } catch {
      // Silently fail -- selector will show fallback
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  // Fetch models lazily (on first dropdown open)
  const fetchModels = useCallback(async () => {
    if (modelsLoaded || modelsLoading || modelsCacheRef.current) return
    setModelsLoading(true)
    try {
      const res = await fetch('/api/providers/available?withModels=true')
      if (res.ok) {
        const data = await res.json()
        const enriched = (data.providers as ProviderInfo[]).filter((p) => p.configured)
        modelsCacheRef.current = enriched
        setProviders(enriched)
        setModelsLoaded(true)
      }
    } catch {
      // Keep existing provider data without model details
    } finally {
      setModelsLoading(false)
    }
  }, [modelsLoaded, modelsLoading])

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  // When dropdown opens, lazily fetch models
  useEffect(() => {
    if (open && !modelsLoaded) {
      fetchModels()
    }
  }, [open, modelsLoaded, fetchModels])

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return

    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setExpandedProvider(null)
      }
    }

    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        setExpandedProvider(null)
      }
    }

    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open])

  const handleProviderClick = useCallback(
    (providerName: string, models?: string[]) => {
      // If provider has multiple models, toggle expand to show sub-list
      if (models && models.length > 1) {
        setExpandedProvider((prev) => (prev === providerName ? null : providerName))
        return
      }
      // Single model or no model list — switch directly
      switchProvider(providerName)
      setActive({ provider: providerName })
      setOpen(false)
      setExpandedProvider(null)
    },
    [switchProvider],
  )

  const handleModelSelect = useCallback(
    (providerName: string, model: string) => {
      switchProvider(providerName, model)
      setActive({ provider: providerName, model })
      setOpen(false)
      setExpandedProvider(null)
    },
    [switchProvider],
  )

  const displayName = active?.provider ?? 'Model'
  const displayLabel = active?.model
    ? `${active.provider}/${active.model}`
    : displayName

  if (loading || providers.length === 0) {
    return null
  }

  return (
    <div className="model-selector" ref={containerRef}>
      <button
        className="model-selector-trigger"
        onClick={() => {
          setOpen((prev) => !prev)
          if (open) setExpandedProvider(null)
        }}
        title="Switch AI provider"
      >
        <span className="model-selector-label">{displayLabel}</span>
        <svg
          className={`model-selector-chevron ${open ? 'open' : ''}`}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 4.5L6 7.5L9 4.5" />
        </svg>
      </button>

      {open && (
        <div className="model-selector-dropdown">
          {modelsLoading && (
            <div className="model-selector-loading">Loading models...</div>
          )}
          {providers.map((p) => {
            const isActive = active?.provider === p.name
            const isExpanded = expandedProvider === p.name
            const hasMultipleModels = p.models && p.models.length > 1

            return (
              <div key={p.name} className="model-selector-group">
                <button
                  className={`model-selector-option ${isActive ? 'active' : ''}`}
                  onClick={() => handleProviderClick(p.name, p.models)}
                >
                  <span className="model-selector-option-name">{p.name}</span>
                  <span className="model-selector-option-icons">
                    {isActive && (
                      <svg
                        className="model-selector-check"
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 7.5L5.5 10L11 4" />
                      </svg>
                    )}
                    {hasMultipleModels && (
                      <svg
                        className={`model-selector-expand ${isExpanded ? 'open' : ''}`}
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M2.5 4L5 6.5L7.5 4" />
                      </svg>
                    )}
                  </span>
                </button>

                {isExpanded && hasMultipleModels && (
                  <div className="model-selector-models">
                    {p.models!.map((model) => {
                      const isModelActive =
                        isActive && active?.model === model
                      return (
                        <button
                          key={model}
                          className={`model-selector-model ${isModelActive ? 'active' : ''}`}
                          onClick={() => handleModelSelect(p.name, model)}
                        >
                          <span className="model-selector-model-name">
                            {model}
                          </span>
                          {isModelActive && (
                            <svg
                              className="model-selector-check"
                              width="12"
                              height="12"
                              viewBox="0 0 14 14"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M3 7.5L5.5 10L11 4" />
                            </svg>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
