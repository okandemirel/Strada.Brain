import { useTranslation } from 'react-i18next'
import { CHANNELS, LANGUAGES, EMBEDDING_CAPABLE, EMBEDDING_PROVIDERS, PROVIDER_MAP } from '../../types/setup-constants'

interface ChannelRagStepProps {
  channel: string
  setChannel: (id: string) => void
  channelConfig: Record<string, string>
  setChannelConfigField: (key: string, value: string) => void
  language: string
  setLanguage: (code: string) => void
  ragEnabled: boolean
  setRagEnabled: (enabled: boolean) => void
  embeddingProvider: string
  setEmbeddingProvider: (provider: string) => void
  embeddingModel: string
  setEmbeddingModel: (model: string) => void
  checkedProviders: Set<string>
  providerKeys: Record<string, string>
  providerAuthModes: Record<string, string>
  setProviderKey: (id: string, key: string) => void
  daemonEnabled: boolean
  setDaemonEnabled: (enabled: boolean) => void
  autonomyEnabled: boolean
  setAutonomyEnabled: (enabled: boolean) => void
  autonomyHours: number
  setAutonomyHours: (hours: number) => void
  daemonBudget: number
  setDaemonBudget: (budget: number) => void
  globalDailyBudget: number
  setGlobalDailyBudget: (budget: number) => void
  onNext: () => void
  onBack: () => void
}

export default function ChannelRagStep({
  channel,
  setChannel,
  channelConfig,
  setChannelConfigField,
  language,
  setLanguage,
  ragEnabled,
  setRagEnabled,
  embeddingProvider,
  setEmbeddingProvider,
  embeddingModel,
  setEmbeddingModel,
  checkedProviders,
  providerKeys,
  providerAuthModes,
  setProviderKey,
  daemonEnabled,
  setDaemonEnabled,
  autonomyEnabled,
  setAutonomyEnabled,
  autonomyHours,
  setAutonomyHours,
  daemonBudget,
  setDaemonBudget,
  globalDailyBudget,
  setGlobalDailyBudget,
  onNext,
  onBack,
}: ChannelRagStepProps) {
  const { t } = useTranslation('setup')
  const selectedChannel = CHANNELS.find((c) => c.id === channel)
  const autoDetectedEmbeddingProviderId = Array.from(checkedProviders).find((id) => EMBEDDING_CAPABLE.has(id))
  const selectedEmbeddingProviderId =
    embeddingProvider !== 'auto' ? embeddingProvider : autoDetectedEmbeddingProviderId
  const embeddingProviderName = selectedEmbeddingProviderId
    ? (PROVIDER_MAP[selectedEmbeddingProviderId]?.name ?? EMBEDDING_PROVIDERS.find((ep) => ep.id === selectedEmbeddingProviderId)?.name ?? selectedEmbeddingProviderId)
    : null
  const explicitEmbeddingProvider =
    embeddingProvider !== 'auto' ? PROVIDER_MAP[embeddingProvider] ?? null : null
  const openaiEmbeddingNeedsApiKey =
    ragEnabled &&
    selectedEmbeddingProviderId === 'openai' &&
    providerAuthModes.openai === 'chatgpt-subscription'
  const needsDedicatedEmbeddingKey = Boolean(
    ragEnabled &&
    explicitEmbeddingProvider?.envKey &&
    (
      !checkedProviders.has(embeddingProvider)
      || (
        embeddingProvider === 'openai'
        && providerAuthModes.openai === 'chatgpt-subscription'
        && !(providerKeys.openai ?? '').trim()
      )
    ),
  )

  return (
    <div className="step">
      <h2>{t('channels.title')}</h2>
      <p className="step-subtitle">
        {t('channels.subtitle')}
      </p>

      <div className="channel-grid">
        {CHANNELS.map((ch) => (
          <label key={ch.id} className="channel-option">
            <input
              type="radio"
              name="channel"
              value={ch.id}
              checked={channel === ch.id}
              onChange={() => setChannel(ch.id)}
            />
            <div className={`channel-card${channel === ch.id ? ' selected' : ''}`}>
              <span className="channel-name">{t(`channels.names.${ch.id}`)}</span>
            </div>
          </label>
        ))}
      </div>

      {selectedChannel && selectedChannel.fields.length > 0 && (
        <div className="channel-fields">
          <h3 className="section-label">{t('channels.configuration', { channel: t(`channels.names.${selectedChannel.id}`) })}</h3>
          {selectedChannel.fields.map((field) => (
            <div key={field.domId} className="channel-field">
              <label htmlFor={field.domId}>{field.labelKey ? t(field.labelKey) : field.label}</label>
              <input
                id={field.domId}
                type="text"
                placeholder={field.placeholder}
                value={channelConfig[field.envKey] ?? ''}
                onChange={(e) => setChannelConfigField(field.envKey, e.target.value)}
                autoComplete="off"
              />
            </div>
          ))}
        </div>
      )}

      <div className="language-select">
        <h3 className="section-label">{t('channels.language.title')}</h3>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {t(`channels.languages.${lang.code}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="rag-toggle">
        <h3 className="section-label">{t('channels.rag.title')}</h3>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={ragEnabled}
            onChange={(e) => setRagEnabled(e.target.checked)}
          />
          <span className="toggle-slider" />
          <span className="toggle-label">
            {ragEnabled ? t('channels.rag.enabled') : t('channels.rag.disabled')}
          </span>
        </label>
        <p className={`rag-info${!ragEnabled || !embeddingProviderName ? ' warning' : ''}`}>
          {!ragEnabled && t('channels.rag.disabledInfo')}
          {ragEnabled && embeddingProviderName && t('channels.rag.enabledWithProvider', { provider: embeddingProviderName })}
          {ragEnabled && !embeddingProviderName && checkedProviders.size > 0 && t('channels.rag.noEmbeddingProviderWithProviders')}
          {ragEnabled && !embeddingProviderName && checkedProviders.size === 0 && t('channels.rag.noEmbeddingProviderNoProviders')}
        </p>

        {ragEnabled && (
          <div className="embedding-provider-select">
            <label htmlFor="embeddingProvider">{t('channels.rag.embeddingProvider')}</label>
            <select
              id="embeddingProvider"
              value={embeddingProvider}
              onChange={(e) => setEmbeddingProvider(e.target.value)}
            >
              {EMBEDDING_PROVIDERS.map((ep) => (
                <option key={ep.id} value={ep.id}>
                  {t(`channels.embeddingProviders.${ep.id}`)}
                </option>
              ))}
            </select>
            <p className="rag-info" style={{ marginTop: '0.65rem' }}>
              {t('channels.rag.embeddingProviderInfo')}
            </p>
            {embeddingProvider !== 'auto' && (
              <div className="channel-field" style={{ marginTop: '0.85rem' }}>
                <label htmlFor="embeddingModel">{t('channels.rag.embeddingModel')}</label>
                <input
                  id="embeddingModel"
                  type="text"
                  placeholder={embeddingProvider === 'ollama' ? 'bge-m3' : t('channels.rag.embeddingModelPlaceholderAuto')}
                  value={embeddingModel}
                  onChange={(e) => setEmbeddingModel(e.target.value)}
                  autoComplete="off"
                />
                <p className="rag-info" style={{ marginTop: '0.45rem' }}>
                  {embeddingProvider === 'ollama'
                    ? t('channels.rag.embeddingModelOllamaInfo')
                    : t('channels.rag.embeddingModelInfo')}
                </p>
              </div>
            )}
            {ragEnabled && !embeddingProviderName && (
              <p className="rag-info warning" style={{ marginTop: '0.55rem' }}>
                {t('channels.rag.blockedInfo')}
              </p>
            )}
            {openaiEmbeddingNeedsApiKey && (
              <p className="rag-info warning" style={{ marginTop: '0.55rem' }}>
                {t('channels.rag.openaiEmbeddingNeedsKey')}
              </p>
            )}
            {needsDedicatedEmbeddingKey && explicitEmbeddingProvider?.envKey && explicitEmbeddingProvider.placeholder && (
              <div className="channel-field" style={{ marginTop: '0.85rem' }}>
                <label htmlFor="embeddingProviderKey">{t('channels.rag.dedicatedEmbeddingKeyLabel', { provider: explicitEmbeddingProvider.name })}</label>
                <input
                  id="embeddingProviderKey"
                  type="password"
                  placeholder={explicitEmbeddingProvider.placeholder}
                  value={providerKeys[embeddingProvider] ?? ''}
                  onChange={(e) => setProviderKey(embeddingProvider, e.target.value)}
                  autoComplete="off"
                />
                <p className="rag-info" style={{ marginTop: '0.55rem' }}>
                  {t('channels.rag.dedicatedEmbeddingKeyInfo', { provider: explicitEmbeddingProvider.name })}
                </p>
                {embeddingProvider === 'openai' && providerAuthModes.openai === 'chatgpt-subscription' && (
                  <p className="rag-info warning" style={{ marginTop: '0.45rem' }}>
                    {t('channels.rag.subscriptionNotUsedForEmbedding')}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="rag-toggle">
        <h3 className="section-label">{t('channels.budget.title')}</h3>
        <p className="rag-info">
          {t('channels.budget.description')}
        </p>
        <div className="autonomy-slider-container">
          <label className="autonomy-budget-label">{t('channels.budget.dailyLimit')}</label>
          <input
            type="range"
            min={0}
            max={50}
            step={1}
            value={globalDailyBudget}
            onChange={(e) => setGlobalDailyBudget(Number(e.target.value))}
            className="autonomy-range"
          />
          <div className="autonomy-labels">
            <span>{t('channels.budget.unlimited')}</span>
            <span className="autonomy-value">{globalDailyBudget === 0 ? t('channels.budget.valueUnlimited') : t('channels.budget.valueAmount', { amount: globalDailyBudget.toFixed(0) })}</span>
            <span>{t('channels.budget.maxLabel')}</span>
          </div>
        </div>
      </div>

      <div className="rag-toggle">
        <h3 className="section-label">{t('channels.daemon.title')}</h3>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={daemonEnabled}
            onChange={(e) => setDaemonEnabled(e.target.checked)}
          />
          <span className="toggle-slider" />
          <span className="toggle-label">
            {daemonEnabled ? t('channels.daemon.enabled') : t('channels.daemon.disabled')}
          </span>
        </label>
        <p className={`rag-info${!daemonEnabled ? ' warning' : ''}`}>
          {daemonEnabled
            ? t('channels.daemon.enabledInfo')
            : t('channels.daemon.disabledInfo')}
        </p>
        {daemonEnabled && (
          <>
            <div className="autonomy-slider-container">
              <label className="autonomy-budget-label">{t('channels.daemon.subLimit')}</label>
              <input
                type="range"
                min={0.5}
                max={10}
                step={0.5}
                value={daemonBudget}
                onChange={(e) => setDaemonBudget(Number(e.target.value))}
                className="autonomy-range"
              />
              <div className="autonomy-labels">
                <span>{t('channels.daemon.subLimitMin')}</span>
                <span className="autonomy-value">${daemonBudget.toFixed(2)}</span>
                <span>{t('channels.daemon.subLimitMax')}</span>
              </div>
            </div>
            <p className="rag-info" style={{ marginTop: '0.3rem', fontSize: '0.75rem' }}>
              {t('channels.daemon.subLimitInfo')}
            </p>
          </>
        )}
      </div>

      <div className="rag-toggle">
        <h3 className="section-label">{t('channels.autonomy.title')}</h3>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={autonomyEnabled}
            onChange={(e) => setAutonomyEnabled(e.target.checked)}
          />
          <span className="toggle-slider" />
          <span className="toggle-label">
            {autonomyEnabled ? t('channels.autonomy.enabled') : t('channels.autonomy.disabled')}
          </span>
        </label>
        <p className={`rag-info${!autonomyEnabled ? ' warning' : ''}`}>
          {autonomyEnabled
            ? t('channels.autonomy.enabledInfo')
            : t('channels.autonomy.disabledInfo')}
        </p>
        {autonomyEnabled && (
          <div className="autonomy-slider-container">
            <label className="autonomy-budget-label">{t('channels.autonomy.duration')}</label>
            <input
              type="range"
              min={1}
              max={168}
              step={1}
              value={autonomyHours}
              onChange={(e) => setAutonomyHours(Number(e.target.value))}
              className="autonomy-range"
            />
            <div className="autonomy-labels">
              <span>{t('channels.autonomy.durationMin')}</span>
              <span className="autonomy-value">{t('channels.autonomy.durationValue', { hours: autonomyHours })}</span>
              <span>{t('channels.autonomy.durationMax')}</span>
            </div>
          </div>
        )}
      </div>

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
