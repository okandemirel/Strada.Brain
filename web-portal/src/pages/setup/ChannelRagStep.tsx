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
      <h2>Channel &amp; Settings</h2>
      <p className="step-subtitle">
        Select your primary communication channel and configure additional settings.
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
              <span className="channel-name">{ch.name}</span>
            </div>
          </label>
        ))}
      </div>

      {selectedChannel && selectedChannel.fields.length > 0 && (
        <div className="channel-fields">
          <h3 className="section-label">{selectedChannel.name} Configuration</h3>
          {selectedChannel.fields.map((field) => (
            <div key={field.domId} className="channel-field">
              <label htmlFor={field.domId}>{field.label}</label>
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
        <h3 className="section-label">Language</h3>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.name}
            </option>
          ))}
        </select>
      </div>

      <div className="rag-toggle">
        <h3 className="section-label">RAG (Retrieval-Augmented Generation)</h3>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={ragEnabled}
            onChange={(e) => setRagEnabled(e.target.checked)}
          />
          <span className="toggle-slider" />
          <span className="toggle-label">
            {ragEnabled ? 'Enabled' : 'Disabled'}
          </span>
        </label>
        <p className={`rag-info${!ragEnabled || !embeddingProviderName ? ' warning' : ''}`}>
          {!ragEnabled && 'RAG is disabled. Code search will not be available.'}
          {ragEnabled && embeddingProviderName && `\u2713 RAG enabled \u2014 will use ${embeddingProviderName} for embeddings, independently from the response provider chain.`}
          {ragEnabled && !embeddingProviderName && checkedProviders.size > 0 && '\u26A0 Your current response providers don\'t support embeddings. Select Gemini, OpenAI, or Ollama as the embedding provider to enable RAG code search.'}
          {ragEnabled && !embeddingProviderName && checkedProviders.size === 0 && '\u26A0 RAG enabled \u2014 embedding provider will be auto-detected from your providers.'}
        </p>

        {ragEnabled && (
          <div className="embedding-provider-select">
            <label htmlFor="embeddingProvider">Embedding Provider</label>
            <select
              id="embeddingProvider"
              value={embeddingProvider}
              onChange={(e) => setEmbeddingProvider(e.target.value)}
            >
              {EMBEDDING_PROVIDERS.map((ep) => (
                <option key={ep.id} value={ep.id}>
                  {ep.name}
                </option>
              ))}
            </select>
            <p className="rag-info" style={{ marginTop: '0.65rem' }}>
              This is a system-wide memory/RAG choice. It does not change which provider Strada uses for conversation turns.
            </p>
            {ragEnabled && !embeddingProviderName && (
              <p className="rag-info warning" style={{ marginTop: '0.55rem' }}>
                You can still continue to review, but setup will stay blocked until you pick a valid embedding provider or disable RAG.
              </p>
            )}
            {openaiEmbeddingNeedsApiKey && (
              <p className="rag-info warning" style={{ marginTop: '0.55rem' }}>
                OpenAI ChatGPT/Codex subscription auth covers conversation only. OpenAI embeddings still require an OpenAI API key.
              </p>
            )}
            {needsDedicatedEmbeddingKey && explicitEmbeddingProvider?.envKey && explicitEmbeddingProvider.placeholder && (
              <div className="channel-field" style={{ marginTop: '0.85rem' }}>
                <label htmlFor="embeddingProviderKey">{explicitEmbeddingProvider.name} Embedding API Key</label>
                <input
                  id="embeddingProviderKey"
                  type="password"
                  placeholder={explicitEmbeddingProvider.placeholder}
                  value={providerKeys[embeddingProvider] ?? ''}
                  onChange={(e) => setProviderKey(embeddingProvider, e.target.value)}
                  autoComplete="off"
                />
                <p className="rag-info" style={{ marginTop: '0.55rem' }}>
                  This key is used only for embeddings. It does not add {explicitEmbeddingProvider.name} to the response provider chain.
                </p>
                {embeddingProvider === 'openai' && providerAuthModes.openai === 'chatgpt-subscription' && (
                  <p className="rag-info warning" style={{ marginTop: '0.45rem' }}>
                    Subscription login is not used for this embedding request path.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="rag-toggle">
        <h3 className="section-label">Global Daily Budget</h3>
        <p className="rag-info">
          Maximum daily spend across all systems (daemon, agents, chat). Set to $0 for unlimited.
        </p>
        <div className="autonomy-slider-container">
          <label className="autonomy-budget-label">Daily Limit</label>
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
            <span>Unlimited</span>
            <span className="autonomy-value">{globalDailyBudget === 0 ? 'Unlimited' : `$${globalDailyBudget.toFixed(0)}`}</span>
            <span>$50</span>
          </div>
        </div>
      </div>

      <div className="rag-toggle">
        <h3 className="section-label">Daemon Mode</h3>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={daemonEnabled}
            onChange={(e) => setDaemonEnabled(e.target.checked)}
          />
          <span className="toggle-slider" />
          <span className="toggle-label">
            {daemonEnabled ? 'Enabled' : 'Disabled'}
          </span>
        </label>
        <p className={`rag-info${!daemonEnabled ? ' warning' : ''}`}>
          {daemonEnabled
            ? 'Daemon mode active \u2014 background monitoring with triggers, scheduled tasks, and proactive assistance.'
            : 'Enable background monitoring with triggers, scheduled tasks, and proactive assistance.'}
        </p>
        {daemonEnabled && (
          <div className="autonomy-slider-container">
            <label className="autonomy-budget-label">Daemon Sub-Limit</label>
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
              <span>$0.50</span>
              <span className="autonomy-value">${daemonBudget.toFixed(2)}</span>
              <span>$10.00</span>
            </div>
          </div>
          <p className="rag-info" style={{ marginTop: '0.3rem', fontSize: '0.75rem' }}>
            Maximum daily spend for daemon triggers only (within the global budget).
          </p>
        )}
      </div>

      <div className="rag-toggle">
        <h3 className="section-label">Autonomy</h3>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={autonomyEnabled}
            onChange={(e) => setAutonomyEnabled(e.target.checked)}
          />
          <span className="toggle-slider" />
          <span className="toggle-label">
            {autonomyEnabled ? 'Enabled' : 'Disabled'}
          </span>
        </label>
        <p className={`rag-info${!autonomyEnabled ? ' warning' : ''}`}>
          {autonomyEnabled
            ? 'Autonomous mode active \u2014 the agent can execute operations without asking for confirmation.'
            : 'Enable autonomous mode to let the agent operate without requiring confirmation for each action.'}
        </p>
        {autonomyEnabled && (
          <div className="autonomy-slider-container">
            <label className="autonomy-budget-label">Duration</label>
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
              <span>1h</span>
              <span className="autonomy-value">{autonomyHours}h</span>
              <span>168h</span>
            </div>
          </div>
        )}
      </div>

      <div className="step-actions">
        <button className="btn btn-secondary" onClick={onBack}>
          Back
        </button>
        <button className="btn btn-primary" onClick={onNext}>
          Next
        </button>
      </div>
    </div>
  )
}
