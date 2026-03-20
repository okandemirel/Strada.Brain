import { useCallback, useEffect, useRef, useState } from 'react'
import { useWS } from '../hooks/useWS'

export interface ProviderInfo {
  name: string
  configured: boolean
  models?: string[]
  activeModel?: string
  contextWindow?: number
  thinkingSupported?: boolean
  specialFeatures?: string[]
  officialSignals?: Array<{
    kind: 'command' | 'feature' | 'model'
    title: string
    value: string
    url: string
    sourceLabel: string
    tags: string[]
  }>
  officialSourceUrls?: string[]
  catalogUpdatedAt?: number
}

export interface ActiveInfo {
  provider: string
  model?: string
  selectionMode?: 'strada-primary-worker'
  executionPolicyNote?: string
}

export interface PrimaryWorkerSelectorSurfaceProps {
  providers: ProviderInfo[]
  active: ActiveInfo | null
  open: boolean
  loading: boolean
  modelsLoading: boolean
  expandedProvider: string | null
  onToggleOpen: () => void
  onProviderClick: (providerName: string, models?: string[]) => void
  onModelSelect: (providerName: string, model: string) => void
}

export function PrimaryWorkerSelectorSurface({
  providers,
  active,
  open,
  loading,
  modelsLoading,
  expandedProvider,
  onToggleOpen,
  onProviderClick,
  onModelSelect,
}: PrimaryWorkerSelectorSurfaceProps) {
  const displayName = active?.provider ?? 'Worker'
  const displayLabel = active?.model
    ? `${active.provider}/${active.model}`
    : displayName

  if (loading || providers.length === 0) {
    return null
  }

  return (
    <>
      <button
        type="button"
        className="model-selector-trigger"
        onClick={onToggleOpen}
        title="Set Strada's primary execution worker"
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
          <div className="model-selector-loading" style={{ textAlign: 'left', lineHeight: 1.4 }}>
            Strada stays in control.
            <br />
            This sets the primary execution worker, not a direct chat target.
          </div>
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
                  type="button"
                  className={`model-selector-option ${isActive ? 'active' : ''}`}
                  onClick={() => onProviderClick(p.name, p.models)}
                >
                  <span className="model-selector-option-name">{p.name}</span>
                  {p.contextWindow && (
                    <span className="model-selector-badges">
                      <span className="badge badge-context">{(p.contextWindow / 1000).toFixed(0)}K</span>
                      {p.thinkingSupported && <span className="badge badge-thinking">Think</span>}
                      {p.catalogUpdatedAt && <span className="badge">Live</span>}
                    </span>
                  )}
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

                {(p.specialFeatures?.length || p.officialSignals?.length) ? (
                  <div className="model-selector-meta" style={{ padding: '0 0.8rem 0.45rem', fontSize: '0.78rem', opacity: 0.75 }}>
                    {p.specialFeatures?.slice(0, 2).join(' • ')}
                    {p.specialFeatures?.length && p.officialSignals?.length ? ' • ' : ''}
                    {p.officialSignals?.length ? `${p.officialSignals.length} live signals` : ''}
                  </div>
                ) : null}

                {isExpanded && hasMultipleModels && (
                  <div className="model-selector-models">
                    {p.models!.map((model) => {
                      const isModelActive =
                        isActive && active?.model === model
                      return (
                        <button
                          type="button"
                          key={model}
                          className={`model-selector-model ${isModelActive ? 'active' : ''}`}
                          onClick={() => onModelSelect(p.name, model)}
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
    </>
  )
}

export default function PrimaryWorkerSelector() {
  const { switchProvider, sessionId, profileId } = useWS()
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [active, setActive] = useState<ActiveInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const modelsCacheRef = useRef<ProviderInfo[] | null>(null)
  const identityQuery = sessionId
    ? new URLSearchParams({
      chatId: sessionId,
      ...(profileId ? { userId: profileId, conversationId: profileId } : {}),
    }).toString()
    : null

  const fetchProviders = useCallback(async () => {
    try {
      const requests: Array<Promise<Response>> = [fetch('/api/providers/available')]
      if (identityQuery) {
        requests.push(fetch(`/api/providers/active?${identityQuery}`))
      }
      const [availRes, activeRes] = await Promise.all(requests)

      if (availRes.ok) {
        const data = await availRes.json()
        setProviders(
          (data.providers as ProviderInfo[]).filter((p) => p.configured),
        )
      }

      if (activeRes?.ok) {
        const data = await activeRes.json()
        setActive(data.active ?? null)
      }
    } catch {
      // Selector falls back to the default label if provider metadata fails to load.
    } finally {
      setLoading(false)
    }
  }, [identityQuery])

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
      // Keep existing provider data without model details.
    } finally {
      setModelsLoading(false)
    }
  }, [modelsLoaded, modelsLoading])

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  useEffect(() => {
    if (open && !modelsLoaded) {
      void fetchModels()
    }
  }, [open, modelsLoaded, fetchModels])

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
      if (models && models.length > 1) {
        setExpandedProvider((prev) => (prev === providerName ? null : providerName))
        return
      }

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

  if (loading || providers.length === 0) {
    return null
  }

  return (
    <div className="model-selector" ref={containerRef}>
      <PrimaryWorkerSelectorSurface
        providers={providers}
        active={active}
        open={open}
        loading={loading}
        modelsLoading={modelsLoading}
        expandedProvider={expandedProvider}
        onToggleOpen={() => {
          setOpen((prev) => !prev)
          if (open) setExpandedProvider(null)
        }}
        onProviderClick={handleProviderClick}
        onModelSelect={handleModelSelect}
      />
    </div>
  )
}
