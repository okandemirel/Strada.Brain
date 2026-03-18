import { PRESETS, EMBEDDING_CAPABLE, EMBEDDING_PROVIDERS, PROVIDER_MAP } from '../../types/setup-constants'
import type { SaveStatus } from '../../types/setup'

interface ReviewStepProps {
  selectedPreset: string | null
  checkedProviders: Set<string>
  providerKeys: Record<string, string>
  providerAuthModes: Record<string, string>
  projectPath: string
  channel: string
  language: string
  ragEnabled: boolean
  embeddingProvider: string
  daemonEnabled: boolean
  daemonBudget: number
  autonomyEnabled: boolean
  autonomyHours: number
  saveStatus: SaveStatus
  saveError: string | null
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
  projectPath,
  channel,
  language,
  ragEnabled,
  embeddingProvider,
  daemonEnabled,
  daemonBudget,
  autonomyEnabled,
  autonomyHours,
  saveStatus,
  saveError,
  onBack,
  onSave,
}: ReviewStepProps) {
  const preset = PRESETS.find((p) => p.id === selectedPreset)
  const providerChain = Array.from(checkedProviders)
    .map((id) => PROVIDER_MAP[id]?.name ?? id)
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

  const isSaving = saveStatus === 'saving' || saveStatus === 'polling'

  return (
    <div className="step">
      <h2>Review &amp; Save</h2>
      <p className="step-subtitle">
        Verify your configuration before saving.
      </p>

      <div className="review-list">
        {Array.from(checkedProviders)
          .filter((id) => {
            const provider = PROVIDER_MAP[id]
            if (id === 'openai' && providerAuthModes.openai === 'chatgpt-subscription') {
              return (providerKeys[id] ?? '').trim().length > 0
            }
            return provider?.envKey && (providerKeys[id] ?? '').trim().length > 0
          })
          .map((id) => {
            const provider = PROVIDER_MAP[id]
            return (
              <div key={id} className="review-item">
                <span className="review-label">
                  {id === 'openai' && providerAuthModes.openai === 'chatgpt-subscription'
                    ? 'OpenAI Embedding Key'
                    : `${provider.name} Key`}
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
              <span className="review-label">{PROVIDER_MAP[effectiveEmbeddingProviderId]!.name} Embedding Key</span>
              <span className="review-value mono">
                {maskKey(explicitEmbeddingProviderKey)}
              </span>
            </div>
          )}

        <div className="review-item">
          <span className="review-label">Preset</span>
          <span className="review-value">
            {preset ? `${preset.name} (${preset.cost})` : 'Custom'}
          </span>
        </div>

        <div className="review-item">
          <span className="review-label">Provider Chain</span>
          <span className="review-value">{providerChain || 'None selected'}</span>
        </div>

        {checkedProviders.has('openai') && (
          <div className="review-item">
            <span className="review-label">OpenAI Auth</span>
            <span className="review-value">
              {providerAuthModes.openai === 'chatgpt-subscription'
                ? 'ChatGPT/Codex subscription'
                : 'API key'}
            </span>
          </div>
        )}

        {checkedProviders.has('openai') && providerAuthModes.openai === 'chatgpt-subscription' && (
          <div className="review-item">
            <span className="review-label">OpenAI Subscription Scope</span>
            <span className="review-value">
              Conversation only. OpenAI embeddings still require an API key.
            </span>
          </div>
        )}

        <div className="review-item">
          <span className="review-label">Project Path</span>
          <span className="review-value mono">{projectPath || 'Not set'}</span>
        </div>

        <div className="review-item">
          <span className="review-label">Channel</span>
          <span className="review-value">{channel}</span>
        </div>

        <div className="review-item">
          <span className="review-label">RAG</span>
          <span className="review-value">
            {!ragEnabled && 'Disabled'}
            {ragEnabled && hasEmbeddingProvider && 'Enabled'}
            {ragEnabled && !hasEmbeddingProvider && 'Enabled (no embedding provider)'}
          </span>
        </div>

        {ragEnabled && (
          <div className="review-item">
            <span className="review-label">Embedding Provider</span>
            <span className="review-value">
              {effectiveEmbeddingProviderName ?? 'None selected'}
            </span>
          </div>
        )}

        <div className="review-item">
          <span className="review-label">Language</span>
          <span className="review-value">{language}</span>
        </div>

        <div className="review-item">
          <span className="review-label">Daemon Mode</span>
          <span className="review-value">{daemonEnabled ? `Enabled ($${daemonBudget.toFixed(2)}/day)` : 'Disabled'}</span>
        </div>

        <div className="review-item">
          <span className="review-label">Autonomy</span>
          <span className="review-value">{autonomyEnabled ? `Enabled (${autonomyHours}h)` : 'Disabled'}</span>
        </div>
      </div>

      {saveStatus === 'success' && (
        <div className="save-message success">
          Configuration saved. Redirecting...
        </div>
      )}

      {saveStatus === 'polling' && (
        <div className="save-message polling">
          Configuration saved. Waiting for server to restart...
        </div>
      )}

      {saveStatus === 'error' && saveError && (
        <div className="save-message error">
          {saveError}
        </div>
      )}

      <div className="step-actions">
        <button className="btn btn-secondary" onClick={onBack} disabled={isSaving}>
          Back
        </button>
        <button className="btn btn-primary" onClick={onSave} disabled={isSaving}>
          {isSaving ? 'Saving...' : 'Save Configuration'}
        </button>
      </div>
    </div>
  )
}
