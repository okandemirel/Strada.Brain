import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useProviders, useRagStatus } from '../../hooks/use-api'
import { useWS } from '../../hooks/useWS'
import { resolveSettingsIdentity } from '../settings-identity'
import PrimaryWorkerSelector from '../../components/PrimaryWorkerSelector'

export default function ProvidersSection() {
  const { t } = useTranslation('settings')
  const { sessionId, profileId } = useWS()
  const identity = resolveSettingsIdentity(sessionId, profileId)
  const { data: providers } = useProviders(identity?.query ?? null)
  const { data: ragData } = useRagStatus()
  const queryClient = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)

  const refreshModels = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await fetch('/api/models/refresh', { method: 'POST' })
      if (!res.ok) throw new Error('Failed')
      toast.success(t('providers.toastRefreshed'))
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['providers'] }), 500)
    } catch {
      toast.error(t('providers.toastRefreshFailed'))
    } finally {
      setRefreshing(false)
    }
  }, [queryClient])

  const ragStatus = ragData?.status
  const active = providers?.active
  const pool = providers?.executionPool ?? []

  return (
    <div>
      <h2 className="text-lg font-semibold text-text mb-1">{t('providers.title')}</h2>
      <p className="text-sm text-text-tertiary mb-6">{t('providers.description')}</p>

      {/* Primary Worker Selector */}
      <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
        {t('providers.primaryWorker')}
      </p>
      <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-text">{t('providers.activeWorker')}</span>
          <div className="relative">
            <PrimaryWorkerSelector />
          </div>
        </div>
        {active && (
          <div className="space-y-1.5 mt-3">
            {active.selectionMode && (
              <div className="flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
                <span className="text-text-secondary">{t('providers.selectionMode')}</span>
                <span className="text-text font-mono text-xs">{active.selectionMode}</span>
              </div>
            )}
            {active.executionPolicyNote && (
              <div className="flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
                <span className="text-text-secondary">{t('providers.policy')}</span>
                <span className="text-text text-xs max-w-[60%] text-right">{active.executionPolicyNote}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Execution Pool */}
      {pool.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
            {t('providers.executionPool')}
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl mb-4 overflow-hidden">
            {pool.map((p, i) => (
              <div
                key={p.name}
                className={`flex justify-between items-center px-4 py-2.5 text-sm ${i < pool.length - 1 ? 'border-b border-white/5' : ''}`}
              >
                <span className="text-text font-medium">{p.label ?? p.name}</span>
                <span className="text-text-secondary font-mono text-xs">{p.defaultModel}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Embedding Status */}
      {ragStatus && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
            {t('providers.embeddingProvider')}
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl mb-4 overflow-hidden">
            <div className="flex justify-between items-center px-4 py-2.5 border-b border-white/5 text-sm">
              <span className="text-text-secondary">{t('providers.provider')}</span>
              <span className="text-text font-mono text-xs">
                {ragStatus.resolvedProviderName ?? ragStatus.configuredProvider}
              </span>
            </div>
            {ragStatus.configuredModel && (
              <div className="flex justify-between items-center px-4 py-2.5 border-b border-white/5 text-sm">
                <span className="text-text-secondary">{t('providers.model')}</span>
                <span className="text-text font-mono text-xs">{ragStatus.configuredModel}</span>
              </div>
            )}
            {ragStatus.activeDimensions != null && (
              <div className="flex justify-between items-center px-4 py-2.5 border-b border-white/5 text-sm">
                <span className="text-text-secondary">{t('providers.dimensions')}</span>
                <span className="text-text font-mono text-xs">{ragStatus.activeDimensions}</span>
              </div>
            )}
            <div className="flex justify-between items-center px-4 py-2.5 text-sm">
              <span className="text-text-secondary">{t('providers.state')}</span>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${ragStatus.verified ? 'bg-green-500/15 text-green-400' : 'bg-yellow-500/15 text-yellow-400'}`}>
                {ragStatus.state}
              </span>
            </div>
            {ragStatus.notice && (
              <div className="px-4 py-2.5 border-t border-white/5 text-xs text-text-tertiary">
                {ragStatus.notice}
              </div>
            )}
          </div>
        </>
      )}

      {/* Refresh Models */}
      <button
        onClick={refreshModels}
        disabled={refreshing}
        className="w-full px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm text-text-secondary hover:bg-white/5 hover:text-text transition-colors disabled:opacity-50"
      >
        {refreshing ? t('providers.refreshing') : t('providers.refreshModels')}
      </button>
    </div>
  )
}
