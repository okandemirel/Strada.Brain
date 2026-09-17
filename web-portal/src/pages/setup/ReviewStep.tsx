import { useTranslation } from 'react-i18next'
import { PRESETS, EMBEDDING_CAPABLE, EMBEDDING_PROVIDERS, PROVIDER_MAP } from '../../types/setup-constants'
import type { SaveStatus } from '../../types/setup'
import { isUnknownBudget, isUnlimitedBudget } from '../../hooks/useSetupWizard'
import { buildSetupRetryHref } from '../../../../src/common/setup-state.ts'

interface ReviewStepProps {
  selectedPreset: string | null
  checkedProviders: Set<string>
  providerKeys: Record<string, string>
  providerAuthModes: Record<string, string>
  providerModels: Record<string, string>
  projectPath: string
  channel: string
  language: string
  ragEnabled: boolean
  embeddingProvider: string
  globalDailyBudget: number
  daemonEnabled: boolean
  daemonBudget: number
  autonomyEnabled: boolean
  autonomyHours: number
  saveStatus: SaveStatus
  saveError: string | null
  saveWarning: string | null
  bootstrapDetail: string | null
  readyUrl: string | null
  saveCommitted: boolean
  canSave: boolean
  saveBlockingReason: string | null
  onBack: () => void
  onSave: () => void
}

function maskKey(key: string): string {
  if (key.length <= 10) return '***'
  return `${key.slice(0, 6)}...${key.slice(-4)}`
}

export default function ReviewStep({
  selectedPreset,
  checkedProviders,
  providerKeys,
  providerAuthModes,
  providerModels,
  projectPath,
  channel,
  language,
  ragEnabled,
  embeddingProvider,
  globalDailyBudget,
  daemonEnabled,
  daemonBudget,
  autonomyEnabled,
  autonomyHours,
  saveStatus,
  saveError,
  saveWarning,
  bootstrapDetail,
  readyUrl,
  saveCommitted,
  canSave,
  saveBlockingReason,
  onBack,
  onSave,
}: ReviewStepProps) {
  // D38 (plan 0-A.32): every label, value and readiness/error line here was
  // hardcoded English although setup.json already carried review.* in all
  // locales; the step ignored the language the user had just picked.
  const { t } = useTranslation('setup')
  const preset = PRESETS.find((p) => p.id === selectedPreset)
  const providerChain = Array.from(checkedProviders)
    .map((id) => {
      const providerName = PROVIDER_MAP[id]?.name ?? id
      const model = providerModels[id]?.trim()
      return model ? `${providerName} / ${model}` : providerName
    })
    .join(', ')

  const autoDetectedEmbeddingProviderId = Array.from(checkedProviders).find((id) =>
    EMBEDDING_CAPABLE.has(id),
  )
  const effectiveEmbeddingProviderId =
    embeddingProvider !== 'auto' ? embeddingProvider : autoDetectedEmbeddingProviderId
  const effectiveEmbeddingProviderName = effectiveEmbeddingProviderId
    ? (EMBEDDING_PROVIDERS.find((ep) => ep.id === effectiveEmbeddingProviderId)?.name
      ?? PROVIDER_MAP[effectiveEmbeddingProviderId]?.name
      ?? effectiveEmbeddingProviderId)
    : null
  const explicitEmbeddingProviderKey =
    effectiveEmbeddingProviderId &&
    !checkedProviders.has(effectiveEmbeddingProviderId)
      ? providerKeys[effectiveEmbeddingProviderId]
      : undefined
  const hasEmbeddingProvider = Boolean(effectiveEmbeddingProviderId)

  const isSaving = saveStatus === 'saving' || saveStatus === 'saved' || saveStatus === 'booting'
  const isSaveDisabled = isSaving || !canSave

  return (
    <div className="step">
      <h2>{t('review.title')}</h2>
      <p className="step-subtitle">
        {t('review.subtitle')}
      </p>

      <div className="review-list">
        {Array.from(checkedProviders)
          .filter((id) => {
            const provider = PROVIDER_MAP[id]
            const authModeDef = provider?.authModes?.find((mode) => mode.id === providerAuthModes[id])
              ?? provider?.authModes?.[0]
            if (authModeDef?.requiresSecret) {
              return (providerKeys[id] ?? '').trim().length > 0
            }
            return provider?.envKey ? (providerKeys[id] ?? '').trim().length > 0 : false
          })
          .map((id) => {
            const provider = PROVIDER_MAP[id]
            const authModeDef = provider?.authModes?.find((mode) => mode.id === providerAuthModes[id])
              ?? provider?.authModes?.[0]
            return (
              <div key={id} className="review-item">
                <span className="review-label">
                  {id === 'openai' && providerAuthModes.openai === 'chatgpt-subscription'
                    ? t('review.labels.openaiEmbeddingKey')
                    : authModeDef?.secretLabel ?? `${provider.name} Key`}
                </span>
                <span className="review-value mono">
                  {maskKey(providerKeys[id])}
                </span>
              </div>
            )
          })}

        {effectiveEmbeddingProviderId &&
          !checkedProviders.has(effectiveEmbeddingProviderId) &&
          explicitEmbeddingProviderKey &&
          explicitEmbeddingProviderKey.trim().length > 0 &&
          PROVIDER_MAP[effectiveEmbeddingProviderId]?.name && (
            <div className="review-item">
              <span className="review-label">{t('review.labels.embeddingKey', { provider: PROVIDER_MAP[effectiveEmbeddingProviderId]!.name })}</span>
              <span className="review-value mono">
                {maskKey(explicitEmbeddingProviderKey)}
              </span>
            </div>
          )}

        <div className="review-item">
          <span className="review-label">{t('review.labels.preset')}</span>
          <span className="review-value">
            {preset ? `${preset.name} (${preset.cost})` : t('review.values.custom')}
          </span>
        </div>

        <div className="review-item">
          <span className="review-label">{t('review.labels.providerChain')}</span>
          <span className="review-value">{providerChain || t('review.values.noneSelected')}</span>
        </div>

        {Array.from(checkedProviders).map((id) => {
          const provider = PROVIDER_MAP[id]
          if (!provider) return null
          const model = providerModels[id]?.trim()
          return (
            <div key={`${id}-model`} className="review-item">
              <span className="review-label">{t('review.labels.providerModel', { provider: provider.name })}</span>
              <span className="review-value mono">{model || t('review.values.default')}</span>
            </div>
          )
        })}

        {checkedProviders.has('openai') && (
          <div className="review-item">
            <span className="review-label">{t('review.labels.openaiAuth')}</span>
            <span className="review-value">
              {providerAuthModes.openai === 'chatgpt-subscription'
                ? t('review.values.openaiChatgptSubscription')
                : t('review.values.openaiApiKey')}
            </span>
          </div>
        )}

        {checkedProviders.has('openai') && providerAuthModes.openai === 'chatgpt-subscription' && (
          <div className="review-item">
            <span className="review-label">{t('review.labels.openaiSubscriptionScope')}</span>
            <span className="review-value">
              {t('review.values.openaiSubscriptionScopeInfo')}
            </span>
          </div>
        )}

        {checkedProviders.has('claude') && (
          <div className="review-item">
            <span className="review-label">{t('review.labels.claudeAuth')}</span>
            <span className="review-value">
              {providerAuthModes.claude === 'claude-subscription'
                ? t('review.values.claudeSubscriptionToken')
                : t('review.values.claudeApiKey')}
            </span>
          </div>
        )}

        {checkedProviders.has('claude') && providerAuthModes.claude === 'claude-subscription' && (
          <div className="review-item">
            <span className="review-label">{t('review.labels.claudeSubscriptionWarning')}</span>
            <span className="review-value">
              {t('review.values.claudeSubscriptionWarningInfo')}
            </span>
          </div>
        )}

        <div className="review-item">
          <span className="review-label">{t('review.labels.projectPath')}</span>
          <span className="review-value mono">{projectPath || t('review.values.notSet')}</span>
        </div>

        <div className="review-item">
          <span className="review-label">{t('review.labels.channel')}</span>
          <span className="review-value">{channel}</span>
        </div>

        <div className="review-item">
          <span className="review-label">{t('review.labels.rag')}</span>
          <span className="review-value">
            {!ragEnabled && t('review.values.disabled')}
            {ragEnabled && hasEmbeddingProvider && t('review.values.enabled')}
            {ragEnabled && !hasEmbeddingProvider && t('review.values.ragBlocked')}
          </span>
        </div>

        {ragEnabled && (
          <div className="review-item">
            <span className="review-label">{t('review.labels.embeddingProvider')}</span>
            <span className="review-value">
              {effectiveEmbeddingProviderName ?? t('review.values.noneSelected')}
            </span>
          </div>
        )}

        {ragEnabled && !hasEmbeddingProvider && (
          <div className="save-message error" style={{ marginTop: 0 }}>
            {t('review.ragBlockedError')}
          </div>
        )}

        {!canSave && saveBlockingReason && (
          <div className="save-message error" style={{ marginTop: ragEnabled && !hasEmbeddingProvider ? '0.75rem' : 0 }}>
            {saveBlockingReason}
          </div>
        )}

        <div className="review-item">
          <span className="review-label">{t('review.labels.language')}</span>
          <span className="review-value">{language}</span>
        </div>

        <div className="review-item">
          <span className="review-label">{t('review.labels.dailyBudget')}</span>
          <span className="review-value">{isUnknownBudget(globalDailyBudget)
            ? t('review.values.budgetUnchanged')
            : isUnlimitedBudget(globalDailyBudget)
            ? t('review.values.budgetUnlimited')
            : globalDailyBudget === 0
              ? t('review.values.budgetFrozen')
              : t('review.values.budgetPerDay', { amount: `$${globalDailyBudget.toFixed(0)}` })}</span>
        </div>

        <div className="review-item">
          <span className="review-label">{t('review.labels.daemonMode')}</span>
          <span className="review-value">
            {daemonEnabled
              ? (daemonBudget > 0
                ? t('review.values.daemonEnabledWithBudget', { amount: `$${daemonBudget.toFixed(2)}` })
                : t('review.values.enabled'))
              : t('review.values.disabled')}
          </span>
        </div>

        <div className="review-item">
          <span className="review-label">{t('review.labels.autonomy')}</span>
          <span className="review-value">{autonomyEnabled ? t('review.values.autonomyEnabledWithHours', { hours: autonomyHours }) : t('review.values.disabled')}</span>
        </div>
      </div>

      {saveStatus === 'saved' && (
        <div className="save-message polling">
          {bootstrapDetail ?? t('review.save.configAccepted')}
        </div>
      )}

      {saveStatus !== 'error' && saveWarning && (
        <div className="save-message polling">
          {saveWarning}
        </div>
      )}

      {saveStatus === 'booting' && (
        <div className="save-message polling">
          {bootstrapDetail ?? t('review.save.booting')}
          {readyUrl && (
            <>
              {' '}
              {t('review.save.bootingOpenLink')} <a href={readyUrl}>{readyUrl}</a>.
            </>
          )}
        </div>
      )}

      {saveStatus === 'success' && (
        <div className="save-message success">
          {bootstrapDetail ?? t('review.save.success')} {t('review.save.sourceCheckoutHint')}
        </div>
      )}

      {saveStatus === 'error' && saveError && (
        <div className="save-message error">
          {saveError}
          {readyUrl && (
            <>
              {' '}
              <a href={readyUrl}>{t('review.save.openMainApp')}</a>
            </>
          )}
          {saveCommitted && (
            <>
              {' '}
              <a href={buildSetupRetryHref()}>{t('review.save.reopenSetup')}</a>
            </>
          )}
        </div>
      )}

      <div className="step-actions">
        <button className="btn btn-secondary" onClick={onBack} disabled={isSaving}>
          {t('wizard.nav.back')}
        </button>
        <button className="btn btn-primary" onClick={onSave} disabled={isSaveDisabled}>
          {isSaving ? t('review.save.saving') : t('review.save.button')}
        </button>
      </div>
    </div>
  )
}
