import { PRESETS, PROVIDERS } from '../../types/setup-constants'

interface ProvidersStepProps {
  selectedPreset: string | null
  selectPreset: (id: string) => void
  checkedProviders: Set<string>
  toggleProvider: (id: string) => void
  providerKeys: Record<string, string>
  providerAuthModes: Record<string, string>
  setProviderKey: (id: string, key: string) => void
  setProviderAuthMode: (id: string, mode: string) => void
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
  return (
    <div className="preset-grid">
      {PRESETS.map((preset) => (
        <div
          key={preset.id}
          className={`preset-card${selectedPreset === preset.id ? ' selected' : ''}`}
          onClick={() => selectPreset(preset.id)}
        >
          <div className="preset-name">{preset.name}</div>
          <div className="preset-cost">{preset.cost}</div>
          <div className="preset-desc">{preset.desc}</div>
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
            <span className="provider-name">{provider.name}</span>
            {provider.recommended && (
              <span className="provider-badge">Recommended</span>
            )}
            {provider.embeddingRecommended && (
              <span className="provider-badge provider-badge-embedding">
                Recommended for embeddings
              </span>
            )}
          </div>
        </label>
      ))}
    </div>
  )
}

export default function ProvidersStep({
  selectedPreset,
  selectPreset,
  checkedProviders,
  toggleProvider,
  providerKeys,
  providerAuthModes,
  setProviderKey,
  setProviderAuthMode,
  onNext,
  onBack,
}: ProvidersStepProps) {
  const providerSettingsProviders = PROVIDERS.filter(
    (p) => checkedProviders.has(p.id) && (p.envKey !== null || (p.authModes?.length ?? 0) > 0),
  )

  return (
    <div className="step">
      <h2>AI Providers</h2>
      <p className="step-subtitle">
        Choose a preset or manually select providers for your AI pipeline.
      </p>

      <PresetGrid selectedPreset={selectedPreset} selectPreset={selectPreset} />

      <h3 className="section-label">Providers</h3>
      <ProviderGrid
        checkedProviders={checkedProviders}
        toggleProvider={toggleProvider}
      />

      {providerSettingsProviders.length > 0 && (
        <div className="provider-keys">
          <h3 className="section-label">Provider Access</h3>
          {providerSettingsProviders.map((provider) => {
            const selectedAuthMode = providerAuthModes[provider.id] ?? provider.authModes?.[0]?.id ?? 'api-key'
            const requiresSecret = provider.id !== 'openai' || selectedAuthMode !== 'chatgpt-subscription'
            return (
            <div key={provider.id} className="provider-key-field">
              {provider.authModes && provider.authModes.length > 1 && (
                <div className="provider-auth-modes" style={{ marginBottom: '0.7rem' }}>
                  {provider.authModes.map((mode) => (
                    <label key={mode.id} className="provider-option" style={{ display: 'block', marginBottom: '0.45rem' }}>
                      <input
                        type="radio"
                        name={`auth-mode-${provider.id}`}
                        checked={(providerAuthModes[provider.id] ?? provider.authModes?.[0]?.id) === mode.id}
                        onChange={() => setProviderAuthMode(provider.id, mode.id)}
                      />
                      <div className="provider-card">
                        <span className="provider-name">{mode.label}</span>
                        <span className="provider-desc" style={{ fontSize: '0.9rem', opacity: 0.8 }}>{mode.description}</span>
                      </div>
                    </label>
                  ))}
                </div>
              )}
              {requiresSecret && (
                <>
                  <label htmlFor={`key-${provider.id}`}>
                    {provider.authModes?.find((mode) => mode.id === selectedAuthMode)?.secretLabel ?? provider.name}
                    {provider.helpUrl && (
                      <a
                        href={provider.helpUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="key-help-link"
                      >
                        Get key
                      </a>
                    )}
                  </label>
                  <input
                    id={`key-${provider.id}`}
                    type="password"
                    placeholder={
                      provider.authModes?.find((mode) => mode.id === selectedAuthMode)?.secretPlaceholder
                      ?? provider.placeholder
                      ?? ''
                    }
                    value={providerKeys[provider.id] ?? ''}
                    onChange={(e) => setProviderKey(provider.id, e.target.value)}
                    autoComplete="off"
                  />
                </>
              )}
              {!requiresSecret && (
                <>
                  <p className="step-subtitle" style={{ marginTop: '0.25rem' }}>
                    Strada will use the local Codex/ChatGPT subscription session available on this machine for OpenAI conversation turns.
                  </p>
                  <p className="step-subtitle warning" style={{ marginTop: '0.35rem' }}>
                    This does not grant OpenAI API or embedding quota. If you later choose OpenAI for embeddings, you still need an OpenAI API key.
                  </p>
                </>
              )}
            </div>
          )})}
        </div>
      )}

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
