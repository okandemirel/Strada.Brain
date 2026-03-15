import { CHANNELS, LANGUAGES, EMBEDDING_CAPABLE } from '../../types/setup-constants'

interface ChannelRagStepProps {
  channel: string
  setChannel: (id: string) => void
  channelConfig: Record<string, string>
  setChannelConfigField: (key: string, value: string) => void
  language: string
  setLanguage: (code: string) => void
  ragEnabled: boolean
  setRagEnabled: (enabled: boolean) => void
  checkedProviders: Set<string>
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
  checkedProviders,
  onNext,
  onBack,
}: ChannelRagStepProps) {
  const selectedChannel = CHANNELS.find((c) => c.id === channel)
  const hasEmbeddingProvider = Array.from(checkedProviders).some((id) =>
    EMBEDDING_CAPABLE.has(id),
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
        <p className="rag-info">
          {hasEmbeddingProvider
            ? 'RAG will use your selected providers for embeddings to enhance context retrieval.'
            : 'None of your selected providers support embeddings. RAG requires an embedding-capable provider (OpenAI, Gemini, Mistral, Together, Fireworks, Qwen, or Ollama).'}
        </p>
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
