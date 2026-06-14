import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useProviders, useProviderModels, useRagStatus } from '../../hooks/use-api'
import { useWS } from '../../hooks/useWS'
import { resolveSettingsIdentity } from '../settings-identity'
import { getProviderModelOptions } from '../../types/setup-constants'
import PrimaryWorkerSelector from '../../components/PrimaryWorkerSelector'
import { PageError } from '../../components/ui/page-error'

export default function ProvidersSection() {
  const { t } = useTranslation('settings')
  const { sessionId, profileId } = useWS()
  const identity = resolveSettingsIdentity(sessionId, profileId)
  const { data: providers, error } = useProviders(identity?.query ?? null)
  const { data: modelCatalog, refetch: refetchModels } = useProviderModels()
  const { data: ragData } = useRagStatus()
  const queryClient = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)

  const refreshModels = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await fetch('/api/providers/models/refresh', { method: 'POST' })
      if (!res.ok) throw new Error('Failed')
      toast.success(t('providers.toastRefreshed'))
      // Pull the freshly-refreshed catalog, and let the active-provider panel
      // pick up any changes too.
      await refetchModels()
      queryClient.invalidateQueries({ queryKey: ['providers'] })
    } catch {
      toast.error(t('providers.toastRefreshFailed'))
    } finally {
      setRefreshing(false)
    }
  }, [queryClient, refetchModels, t])

  const ragStatus = ragData?.status
  const active = providers?.active
  const pool = providers?.executionPool ?? []

  // Per-provider available models, sourced from the live catalog. When a
  // provider's live list is empty/unavailable, fall back to the static curated
  // catalog so the picker always shows something selectable.
  const catalogProviders = modelCatalog?.providers ?? []
  const modelGroups = catalogProviders.map((entry) => {
    const liveModels = Array.isArray(entry.models) ? entry.models : []
    const usingLive = liveModels.length > 0
    const models = usingLive
      ? liveModels
      : getProviderModelOptions(entry.name).map((option) => option.model)
    return {
      name: entry.name,
      models,
      usingLive,
      stale: usingLive && entry.stale === true,
    }
  }).filter((group) => group.models.length > 0)

  // Only surfaced once the query actually runs (it's disabled until a session
  // identity exists), so a pre-session render still shows the section chrome.
  if (error) {
    return <PageError title={t('section.errorTitle')} message={error instanceof Error ? error.message : t('section.errorFallback')} />
  }

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

      {/* Available Models (live catalog, static fallback) */}
      {modelGroups.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
            {t('providers.availableModels')}
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl mb-4 overflow-hidden">
            {modelGroups.map((group, i) => (
              <div
                key={group.name}
                className={`px-4 py-3 text-sm ${i < modelGroups.length - 1 ? 'border-b border-white/5' : ''}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-text font-medium">{group.name}</span>
                  {group.stale ? (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400">
                      {t('providers.modelsStale')}
                    </span>
                  ) : group.usingLive ? (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400">
                      {t('providers.modelsLive')}
                    </span>
                  ) : (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-white/5 text-text-tertiary">
                      {t('providers.modelsCurated')}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {group.models.map((model) => (
                    <span
                      key={model}
                      className="text-text-secondary font-mono text-[11px] px-2 py-0.5 rounded bg-white/3 border border-white/5"
                    >
                      {model}
                    </span>
                  ))}
                </div>
              </div>
            ))}
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
