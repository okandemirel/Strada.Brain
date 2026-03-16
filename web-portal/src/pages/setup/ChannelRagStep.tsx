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
  daemonEnabled: boolean
  setDaemonEnabled: (enabled: boolean) => void
  autonomyHours: number
  setAutonomyHours: (hours: number) => void
  daemonBudget: number
  setDaemonBudget: (budget: number) => void
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
  daemonEnabled,
  setDaemonEnabled,
  autonomyHours,
  setAutonomyHours,
  daemonBudget,
  setDaemonBudget,
  onNext,
  onBack,
}: ChannelRagStepProps) {
  const selectedChannel = CHANNELS.find((c) => c.id === channel)
  const embeddingProviderId = Array.from(checkedProviders).find((id) => EMBEDDING_CAPABLE.has(id))
  const embeddingProviderName = embeddingProviderId ? PROVIDER_MAP[embeddingProviderId]?.name : null

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
          {ragEnabled && embeddingProviderName && `\u2713 RAG enabled \u2014 will use ${embeddingProviderName} for embeddings.`}
          {ragEnabled && !embeddingProviderName && checkedProviders.size > 0 && '\u26A0 Your selected providers don\'t support embeddings. Go back and add Ollama (free, local) or Gemini to enable RAG code search.'}
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
          </div>
        )}
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
            <label className="autonomy-budget-label">Daily Budget</label>
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
        )}
      </div>

      <div className="rag-toggle">
        <h3 className="section-label">Autonomy</h3>
        <p className="rag-info">
          How long the agent can operate autonomously before requiring user check-in.
        </p>
        <div className="autonomy-slider-container">
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
