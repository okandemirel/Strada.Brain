import { PRESETS, PROVIDERS } from '../../types/setup-constants'

interface ProvidersStepProps {
  selectedPreset: string | null
  selectPreset: (id: string) => void
  checkedProviders: Set<string>
  toggleProvider: (id: string) => void
  providerKeys: Record<string, string>
  setProviderKey: (id: string, key: string) => void
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
  setProviderKey,
  onNext,
  onBack,
}: ProvidersStepProps) {
  const providersNeedingKeys = PROVIDERS.filter(
    (p) => checkedProviders.has(p.id) && p.envKey !== null,
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

      {providersNeedingKeys.length > 0 && (
        <div className="provider-keys">
          <h3 className="section-label">API Keys</h3>
          {providersNeedingKeys.map((provider) => (
            <div key={provider.id} className="provider-key-field">
              <label htmlFor={`key-${provider.id}`}>
                {provider.name}
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
                placeholder={provider.placeholder ?? ''}
                value={providerKeys[provider.id] ?? ''}
                onChange={(e) => setProviderKey(provider.id, e.target.value)}
                autoComplete="off"
              />
            </div>
          ))}
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
