import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

interface McpStatus {
  installed: boolean
  version: string | null
  toolCount: number
  resourceCount: number
  promptCount: number
  bridgeConfigured: boolean
  bridgeConnected: boolean
  bridgeState: string
  availableToolCount: number
  unavailableToolCount: number
  activeEditorPort?: number | null
  activeEditorProjectName?: string | null
  editorSelectionSource?: string | null
  editorDiscoveryCount?: number
  bridgeUnavailableReason?: string
  lastError?: string
  bridgeProtocolVersion?: string
  bridgeCapabilityMethodCount?: number
}

interface McpStatusResponse {
  installed: boolean
  status: McpStatus | null
}

export default function McpSection() {
  const { t } = useTranslation('settings')
  const [installed, setInstalled] = useState(false)
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback((notifyError: boolean) => {
    setBusy(true)
    return fetch('/api/mcp/status')
      .then((r) => (r.ok ? (r.json() as Promise<McpStatusResponse>) : null))
      .then((d) => {
        if (!d) throw new Error('Request failed')
        setInstalled(Boolean(d.installed))
        setStatus(d.status ?? null)
      })
      .catch(() => {
        if (notifyError) toast.error(t('mcp.toastFailed'))
      })
      .finally(() => {
        setBusy(false)
        setLoaded(true)
      })
  }, [t])

  useEffect(() => {
    void refresh(false)
  }, [refresh])

  const reconnect = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/mcp/reconnect', { method: 'POST' })
      if (!res.ok) throw new Error('Request failed')
      const d = (await res.json()) as { bridgeConnected: boolean; status: McpStatus | null }
      if (d.status) {
        setInstalled(Boolean(d.status.installed))
        setStatus(d.status)
      }
      if (d.bridgeConnected) {
        toast.success(t('mcp.toastReconnected'))
      } else {
        toast.info(t('mcp.toastStillDisconnected'))
      }
    } catch {
      toast.error(t('mcp.toastFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) {
    return (
      <div>
        <h2 className="text-lg font-semibold text-text mb-1">{t('mcp.title')}</h2>
        <p className="text-sm text-text-tertiary">{t('hub.loading')}</p>
      </div>
    )
  }

  const editorLabel = status?.activeEditorProjectName
    ? `${status.activeEditorProjectName}${status.activeEditorPort ? ` (:${status.activeEditorPort})` : ''}`
    : t('mcp.noEditor')

  return (
    <div>
      <h2 className="text-lg font-semibold text-text mb-1">{t('mcp.title')}</h2>
      <p className="text-sm text-text-tertiary mb-6">{t('mcp.description')}</p>

      <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl mb-4 overflow-hidden">
        {!installed || !status ? (
          <div className="px-4 py-2.5 text-sm text-text-secondary">{t('mcp.notInstalled')}</div>
        ) : (
          <>
            <div className="flex justify-between items-center px-4 py-2.5 border-b border-white/5 text-sm">
              <span className="text-text-secondary">{t('mcp.bridgeState')}</span>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${status.bridgeConnected ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
                {status.bridgeState}
              </span>
            </div>
            <div className="flex justify-between items-center px-4 py-2.5 border-b border-white/5 text-sm">
              <span className="text-text-secondary">{t('mcp.version')}</span>
              <span className="text-text font-mono text-xs">{status.version ?? '—'}</span>
            </div>
            <div className="flex justify-between items-center px-4 py-2.5 border-b border-white/5 text-sm">
              <span className="text-text-secondary">{t('mcp.tools')}</span>
              <span className="text-text">
                {t('mcp.toolsAvailable', { available: status.availableToolCount, total: status.toolCount })}
              </span>
            </div>
            <div className="flex justify-between items-center px-4 py-2.5 text-sm">
              <span className="text-text-secondary">{t('mcp.activeEditor')}</span>
              <span className="text-text">{editorLabel}</span>
            </div>
            {(status.bridgeUnavailableReason || status.lastError) && (
              <div className="px-4 py-2.5 border-t border-white/5 text-sm">
                <p className="text-text-secondary">{t('mcp.lastError')}</p>
                <p className="text-xs text-red-400/90 mt-1 break-words">
                  {status.bridgeUnavailableReason ?? status.lastError}
                </p>
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex gap-3">
        <button
          onClick={() => void refresh(true)}
          disabled={busy}
          className="px-5 py-2 bg-white/5 border border-white/10 text-text-secondary text-sm font-medium rounded-xl hover:bg-white/10 transition-colors disabled:opacity-50"
        >
          {t('mcp.refresh')}
        </button>
        {installed && status && (
          <button
            onClick={() => void reconnect()}
            disabled={busy}
            className="px-5 py-2 bg-accent/20 border border-accent/30 text-accent text-sm font-medium rounded-xl hover:bg-accent/30 transition-colors disabled:opacity-50"
          >
            {busy ? t('mcp.reconnecting') : t('mcp.reconnect')}
          </button>
        )}
      </div>
    </div>
  )
}
