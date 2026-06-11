import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useMcpStatus } from '../../hooks/use-api'
import type { McpStatus } from '../../hooks/use-api'
import { fetchJson } from '../../utils/api'
import { glass } from '../../lib/styles'

interface ReconnectResponse {
  bridgeConnected: boolean
  status: McpStatus | null
}

export default function McpSection() {
  const { t } = useTranslation('settings')
  const { data, isLoading, refetch } = useMcpStatus()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)

  const installed = Boolean(data?.installed)
  const status = data?.status ?? null

  const refresh = async () => {
    setBusy(true)
    try {
      const result = await refetch()
      if (result.error) toast.error(t('mcp.toastFailed'))
    } finally {
      setBusy(false)
    }
  }

  const reconnect = async () => {
    setBusy(true)
    try {
      const d = await fetchJson<ReconnectResponse>('/api/mcp/reconnect', { method: 'POST' })
      if (d?.bridgeConnected) {
        toast.success(t('mcp.toastReconnected'))
      } else {
        toast.info(t('mcp.toastStillDisconnected'))
      }
      // A reconnect changes both the bridge status and tool availability.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mcp-status'] }),
        queryClient.invalidateQueries({ queryKey: ['tools'] }),
      ])
    } catch {
      toast.error(t('mcp.toastFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (isLoading) {
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

      <div className={`${glass.section} mb-4 overflow-hidden`}>
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
          onClick={() => void refresh()}
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
