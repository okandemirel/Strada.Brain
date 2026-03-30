import { useTranslation } from 'react-i18next'
import {
  PRESETS,
  PROVIDERS,
  getDefaultProviderModel,
  getProviderModelOptions,
} from '../../types/setup-constants'

interface ProvidersStepProps {
  selectedPreset: string | null
  selectPreset: (id: string) => void
  checkedProviders: Set<string>
  toggleProvider: (id: string) => void
  providerKeys: Record<string, string>
  providerAuthModes: Record<string, string>
  providerModels: Record<string, string>
  setProviderKey: (id: string, key: string) => void
  setProviderAuthMode: (id: string, mode: string) => void
  setProviderModel: (id: string, model: string) => void
  onNext: () => void
  onBack: () => void
}

function PresetGrid({
  selectedPreset,
  selectPreset,
}: {
  selectedPreset: string | null
  selectPreset: (id: string) => void
}) {
  const { t } = useTranslation('setup')
  return (
    <div className="preset-grid">
      {PRESETS.map((preset) => (
        <div
          key={preset.id}
          className={`preset-card${selectedPreset === preset.id ? ' selected' : ''}`}
          onClick={() => selectPreset(preset.id)}
        >
          <div className="preset-name">{t(`providers.presets.${preset.id}.name`)}</div>
          <div className="preset-cost">{t(`providers.presets.${preset.id}.cost`)}</div>
          <div className="preset-desc">{t(`providers.presets.${preset.id}.desc`)}</div>
        </div>
      ))}
    </div>
  )
}

function ProviderGrid({
  checkedProviders,
  toggleProvider,
}: {
  checkedProviders: Set<string>
  toggleProvider: (id: string) => void
}) {
  const { t } = useTranslation('setup')
  return (
    <div className="provider-grid">
      {PROVIDERS.map((provider) => (
        <label key={provider.id} className="provider-option">
          <input
            type="checkbox"
            checked={checkedProviders.has(provider.id)}
            onChange={() => toggleProvider(provider.id)}
          />
          <div className="provider-card">
            <span className="provider-name">{t(`providers.providerNames.${provider.id}`)}</span>
            {provider.recommended && (
              <span className="provider-badge">{t('providers.recommended')}</span>
            )}
            {provider.embeddingRecommended && (
              <span className="provider-badge provider-badge-embedding">
                {t('providers.embeddingRecommended')}
              </span>
            )}
          </div>
        </label>
      ))}
    </div>
  )
}

const TIER_KEYS: Record<string, string> = {
  budget: 'providers.tier.budget',
  standard: 'providers.tier.standard',
  premium: 'providers.tier.premium',
}

export default function ProvidersStep({
  selectedPreset,
  selectPreset,
  checkedProviders,
  toggleProvider,
  providerKeys,
  providerAuthModes,
  providerModels,
  setProviderKey,
  setProviderAuthMode,
  setProviderModel,
  onNext,
  onBack,
}: ProvidersStepProps) {
  const { t } = useTranslation('setup')
  const providerSettingsProviders = PROVIDERS.filter((p) => checkedProviders.has(p.id))

  return (
    <div className="step">
      <h2>{t('providers.title')}</h2>
      <p className="step-subtitle">
        {t('providers.subtitle')}
      </p>

      <PresetGrid selectedPreset={selectedPreset} selectPreset={selectPreset} />

      <h3 className="section-label">{t('providers.sectionProviders')}</h3>
      <ProviderGrid
        checkedProviders={checkedProviders}
        toggleProvider={toggleProvider}
      />

      {providerSettingsProviders.length > 0 && (
        <div className="provider-keys">
          <h3 className="section-label">{t('providers.sectionAccess')}</h3>
          {providerSettingsProviders.map((provider) => {
            const modelOptions = getProviderModelOptions(provider.id)
            const selectedAuthMode = providerAuthModes[provider.id] ?? provider.authModes?.[0]?.id ?? 'api-key'
            const selectedAuthModeDef = provider.authModes?.find((mode) => mode.id === selectedAuthMode)
            const usingOpenAISubscription = provider.id === 'openai' && selectedAuthMode === 'chatgpt-subscription'
            const usingClaudeSubscription = provider.id === 'claude' && selectedAuthMode === 'claude-subscription'
            const showsCredentialField = selectedAuthModeDef?.requiresSecret ?? (provider.envKey !== null && !usingOpenAISubscription)
            const selectedModel = providerModels[provider.id] ?? getDefaultProviderModel(provider.id) ?? ''
            const helpUrl = selectedAuthModeDef?.helpUrl ?? provider.helpUrl
            const helpLabel = selectedAuthModeDef?.helpLabel ?? t('providers.getKey')

            return (
              <div key={provider.id} className="provider-key-field">
                <div className="provider-access-header">
                  <div>
                    <div className="provider-access-name">{t(`providers.providerNames.${provider.id}`)}</div>
                    <div className="provider-access-summary">
                      {t('providers.accessSummary')}
                    </div>
                  </div>
                  {selectedModel && (
                    <div className="provider-access-pill">{selectedModel}</div>
                  )}
                </div>

                {provider.authModes && provider.authModes.length > 1 && (
                  <div className="provider-choice-group">
                    <div className="provider-field-label">{t('providers.accessMode')}</div>
                    <div className="provider-auth-grid">
                    {provider.authModes.map((mode) => {
                      const modeKeySegment = mode.id === 'api-key' ? 'apiKey' : mode.id === 'chatgpt-subscription' ? 'chatgptSubscription' : mode.id === 'claude-subscription' ? 'subscription' : mode.id
                      return (
                        <button
                          type="button"
                          key={mode.id}
                          className={`provider-choice-card ${
                            (providerAuthModes[provider.id] ?? provider.authModes?.[0]?.id) === mode.id
                              ? 'selected'
                              : ''
                          }`}
                          onClick={() => setProviderAuthMode(provider.id, mode.id)}
                        >
                          <span className="provider-choice-title">{t(`providers.authModes.${provider.id}.${modeKeySegment}.label`)}</span>
                          <span className="provider-choice-copy">{t(`providers.authModes.${provider.id}.${modeKeySegment}.description`)}</span>
                        </button>
                      )
                    })}
                    </div>
                  </div>
                )}

                <div className="provider-choice-group">
                  <div className="provider-field-label">{t('providers.defaultModel')}</div>
                  {modelOptions.length > 0 ? (
                    <div className="provider-model-grid">
                      {modelOptions.map((option) => (
                        <button
                          type="button"
                          key={option.model}
                          className={`provider-model-card ${selectedModel === option.model ? 'selected' : ''}`}
                          onClick={() => setProviderModel(provider.id, option.model)}
                        >
                          <div className="provider-model-header">
                            <span className="provider-model-title">{option.label}</span>
                            <span className={`provider-model-tier tier-${option.tier}`}>
                              {t(TIER_KEYS[option.tier] ?? option.tier)}
                            </span>
                          </div>
                          <div className="provider-model-id">{option.model}</div>
                          <div className="provider-model-stats">
                            <span>{option.contextWindow}</span>
                            <span>{t('providers.modelStats.in', { amount: option.inputPer1M.toFixed(2) })}</span>
                            <span>{t('providers.modelStats.out', { amount: option.outputPer1M.toFixed(2) })}</span>
                          </div>
                          <div className="provider-model-notes">{option.notes}</div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <input
                      id={`model-${provider.id}`}
                      type="text"
                      value={selectedModel}
                      placeholder={getDefaultProviderModel(provider.id) ?? t('providers.modelPlaceholder')}
                      onChange={(e) => setProviderModel(provider.id, e.target.value)}
                      autoComplete="off"
                    />
                  )}
                </div>

                {showsCredentialField && (
                  <>
                    <label htmlFor={`key-${provider.id}`}>
                      {(() => {
                        const modeKeySegment = selectedAuthMode === 'api-key' ? 'apiKey' : selectedAuthMode === 'chatgpt-subscription' ? 'chatgptSubscription' : selectedAuthMode === 'claude-subscription' ? 'subscription' : selectedAuthMode
                        const secretLabelKey = `providers.authModes.${provider.id}.${modeKeySegment}.secretLabel`
                        return t(secretLabelKey, { defaultValue: selectedAuthModeDef?.secretLabel ?? t(`providers.providerNames.${provider.id}`) })
                      })()}
                      {helpUrl && (
                        <a
                          href={helpUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="key-help-link"
                        >
                          {(() => {
                            const modeKeySegment = selectedAuthMode === 'api-key' ? 'apiKey' : selectedAuthMode === 'chatgpt-subscription' ? 'chatgptSubscription' : selectedAuthMode === 'claude-subscription' ? 'subscription' : selectedAuthMode
                            const helpLabelKey = `providers.authModes.${provider.id}.${modeKeySegment}.helpLabel`
                            return t(helpLabelKey, { defaultValue: helpLabel })
                          })()}
                        </a>
                      )}
                    </label>
                    <input
                      id={`key-${provider.id}`}
                      type="password"
                      placeholder={
                        selectedAuthModeDef?.secretPlaceholder
                        ?? provider.placeholder
                        ?? ''
                      }
                      value={providerKeys[provider.id] ?? ''}
                      onChange={(e) => setProviderKey(provider.id, e.target.value)}
                      autoComplete="off"
                    />
                  </>
                )}

                {usingOpenAISubscription && (
                  <div className="provider-helper-copy">
                    <p>
                      {t('providers.openai.subscriptionInfo')}
                    </p>
                    <p className="warning">
                      {t('providers.openai.subscriptionWarning')}
                    </p>
                  </div>
                )}

                {usingClaudeSubscription && (
                  <div className="provider-helper-copy">
                    <p>
                      {t('providers.claude.subscriptionInfo')}
                    </p>
                    <p className="warning">
                      {t('providers.claude.subscriptionWarning')}
                    </p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div className="step-actions">
        <button className="btn btn-secondary" onClick={onBack}>
          {t('wizard.nav.back')}
        </button>
        <button className="btn btn-primary" onClick={onNext}>
          {t('wizard.nav.next')}
        </button>
      </div>
    </div>
  )
}
