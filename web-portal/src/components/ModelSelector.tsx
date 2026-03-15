import { useCallback, useEffect, useRef, useState } from 'react'
import { useWS } from '../contexts/WebSocketContext'

interface ProviderInfo {
  name: string
  configured: boolean
  models?: string[]
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
  const containerRef = useRef<HTMLDivElement>(null)

  // Fetch available providers and active provider
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

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return

    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }

    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open])

  const handleSelect = useCallback(
    (providerName: string) => {
      switchProvider(providerName)
      setActive({ provider: providerName })
      setOpen(false)
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
        onClick={() => setOpen((prev) => !prev)}
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
          {providers.map((p) => {
            const isActive = active?.provider === p.name
            return (
              <button
                key={p.name}
                className={`model-selector-option ${isActive ? 'active' : ''}`}
                onClick={() => handleSelect(p.name)}
              >
                <span className="model-selector-option-name">{p.name}</span>
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
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
