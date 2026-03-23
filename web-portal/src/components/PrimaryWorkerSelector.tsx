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
        className="flex items-center gap-1.5 bg-white/[0.03] backdrop-blur border border-white/5 rounded-lg px-2.5 py-[5px] cursor-pointer text-text-secondary text-xs font-medium transition-all duration-200 whitespace-nowrap hover:bg-white/5 hover:text-text hover:border-border-hover"
        onClick={onToggleOpen}
        title="Set Strada's primary execution worker"
      >
        <span className="max-w-[180px] overflow-hidden text-ellipsis">{displayLabel}</span>
        <svg
          className={`shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
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
        <div className="absolute top-[calc(100%+4px)] right-0 min-w-[200px] max-h-[360px] overflow-y-auto bg-bg-secondary border border-border rounded-[10px] p-1 z-[100] shadow-[0_8px_24px_rgba(0,0,0,0.3)] backdrop-blur-[40px] backdrop-saturate-[180%]">
          <div className="px-3 py-2 text-[11px] text-text-secondary opacity-70 text-left leading-snug">
            Strada stays in control.
            <br />
            This sets the primary execution worker, not a direct chat target.
          </div>
          {modelsLoading && (
            <div className="px-3 py-2 text-[11px] text-text-secondary opacity-70 text-center">Loading models...</div>
          )}
          {providers.map((p) => {
            const isActive = active?.provider === p.name
            const isExpanded = expandedProvider === p.name
            const hasMultipleModels = p.models && p.models.length > 1

            return (
              <div key={p.name} className="flex flex-col">
                <button
                  type="button"
                  className={`flex items-center justify-between w-full px-3 py-2 bg-transparent border-none rounded-[7px] cursor-pointer text-[13px] font-medium text-left transition-all duration-150 hover:bg-bg-tertiary hover:text-text ${isActive ? 'text-accent' : 'text-text-secondary'}`}
                  onClick={() => onProviderClick(p.name, p.models)}
                >
                  <span>{p.name}</span>
                  {p.contextWindow && (
                    <span className="flex items-center gap-1 shrink-0">
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-bg-tertiary text-text-tertiary">{(p.contextWindow / 1000).toFixed(0)}K</span>
                      {p.thinkingSupported && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-bg-tertiary text-text-tertiary">Think</span>}
                      {p.catalogUpdatedAt && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-bg-tertiary text-text-tertiary">Live</span>}
                    </span>
                  )}
                  <span className="flex items-center gap-1 shrink-0">
                    {isActive && (
                      <svg className="shrink-0 text-accent" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 7.5L5.5 10L11 4" />
                      </svg>
                    )}
                    {hasMultipleModels && (
                      <svg className={`shrink-0 transition-transform duration-200 opacity-50 ${isExpanded ? 'rotate-180 opacity-100' : ''}`} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2.5 4L5 6.5L7.5 4" />
                      </svg>
                    )}
                  </span>
                </button>

                {(p.specialFeatures?.length || p.officialSignals?.length) ? (
                  <div className="px-3 pb-[6px] text-[0.78rem] opacity-75 text-text-secondary">
                    {p.specialFeatures?.slice(0, 2).join(' \u2022 ')}
                    {p.specialFeatures?.length && p.officialSignals?.length ? ' \u2022 ' : ''}
                    {p.officialSignals?.length ? `${p.officialSignals.length} live signals` : ''}
                  </div>
                ) : null}

                {isExpanded && hasMultipleModels && (
                  <div className="pl-3 border-l-2 border-border ml-3 mb-0.5">
                    {p.models!.map((model) => {
                      const isModelActive = isActive && active?.model === model
                      return (
                        <button
                          type="button"
                          key={model}
                          className={`flex items-center justify-between w-full px-2.5 py-[5px] bg-transparent border-none rounded-md cursor-pointer text-xs font-normal text-left transition-all duration-150 hover:bg-bg-tertiary hover:text-text ${isModelActive ? 'text-accent' : 'text-text-secondary'}`}
                          onClick={() => onModelSelect(p.name, model)}
                        >
                          <span className="overflow-hidden text-ellipsis whitespace-nowrap max-w-[200px]">{model}</span>
                          {isModelActive && (
                            <svg className="shrink-0 text-accent" width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
    <div className="relative" ref={containerRef}>
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
