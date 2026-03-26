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

function formatTierLabel(tier: 'budget' | 'standard' | 'premium'): string {
  switch (tier) {
    case 'budget':
      return 'Budget'
    case 'standard':
      return 'Balanced'
    case 'premium':
      return 'Frontier'
  }
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
  const providerSettingsProviders = PROVIDERS.filter((p) => checkedProviders.has(p.id))

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
            const modelOptions = getProviderModelOptions(provider.id)
            const selectedAuthMode = providerAuthModes[provider.id] ?? provider.authModes?.[0]?.id ?? 'api-key'
            const selectedAuthModeDef = provider.authModes?.find((mode) => mode.id === selectedAuthMode)
            const usingOpenAISubscription = provider.id === 'openai' && selectedAuthMode === 'chatgpt-subscription'
            const usingClaudeSubscription = provider.id === 'claude' && selectedAuthMode === 'claude-subscription'
            const showsCredentialField = selectedAuthModeDef?.requiresSecret ?? (provider.envKey !== null && !usingOpenAISubscription)
            const selectedModel = providerModels[provider.id] ?? getDefaultProviderModel(provider.id) ?? ''
            const helpUrl = selectedAuthModeDef?.helpUrl ?? provider.helpUrl
            const helpLabel = selectedAuthModeDef?.helpLabel ?? 'Get key'

            return (
              <div key={provider.id} className="provider-key-field">
                <div className="provider-access-header">
                  <div>
                    <div className="provider-access-name">{provider.name}</div>
                    <div className="provider-access-summary">
                      Configure the default worker model and access mode Strada should use after setup.
                    </div>
                  </div>
                  {selectedModel && (
                    <div className="provider-access-pill">{selectedModel}</div>
                  )}
                </div>

                {provider.authModes && provider.authModes.length > 1 && (
                  <div className="provider-choice-group">
                    <div className="provider-field-label">Access Mode</div>
                    <div className="provider-auth-grid">
                    {provider.authModes.map((mode) => (
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
                        <span className="provider-choice-title">{mode.label}</span>
                        <span className="provider-choice-copy">{mode.description}</span>
                      </button>
                    ))}
                    </div>
                  </div>
                )}

                <div className="provider-choice-group">
                  <div className="provider-field-label">Default Model</div>
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
                              {formatTierLabel(option.tier)}
                            </span>
                          </div>
                          <div className="provider-model-id">{option.model}</div>
                          <div className="provider-model-stats">
                            <span>{option.contextWindow}</span>
                            <span>${option.inputPer1M.toFixed(2)} in</span>
                            <span>${option.outputPer1M.toFixed(2)} out</span>
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
                      placeholder={getDefaultProviderModel(provider.id) ?? 'Enter model id'}
                      onChange={(e) => setProviderModel(provider.id, e.target.value)}
                      autoComplete="off"
                    />
                  )}
                </div>

                {showsCredentialField && (
                  <>
                    <label htmlFor={`key-${provider.id}`}>
                      {selectedAuthModeDef?.secretLabel ?? provider.name}
                      {helpUrl && (
                        <a
                          href={helpUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="key-help-link"
                        >
                          {helpLabel}
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
                      Strada will use the local Codex/ChatGPT subscription session available on this machine for OpenAI conversation turns.
                    </p>
                    <p className="warning">
                      This does not grant OpenAI API or embedding quota. If you later choose OpenAI for embeddings, you still need an OpenAI API key.
                    </p>
                  </div>
                )}

                {usingClaudeSubscription && (
                  <div className="provider-helper-copy">
                    <p>
                      Strada will send Claude requests with the subscription token you provide here.
                    </p>
                    <p className="warning">
                      Anthropic documents claude.ai subscription auth as restricted outside Claude Code and Claude.ai. Strada exposes this mode only if you choose to use it, at your own risk.
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
          Back
        </button>
        <button className="btn btn-primary" onClick={onNext}>
          Next
        </button>
      </div>
    </div>
  )
}
