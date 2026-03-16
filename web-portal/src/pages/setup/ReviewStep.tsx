import { PRESETS, EMBEDDING_CAPABLE, EMBEDDING_PROVIDERS, PROVIDER_MAP } from '../../types/setup-constants'
import type { SaveStatus } from '../../types/setup'

interface ReviewStepProps {
  selectedPreset: string | null
  checkedProviders: Set<string>
  providerKeys: Record<string, string>
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

  const hasEmbeddingProvider = Array.from(checkedProviders).some((id) =>
    EMBEDDING_CAPABLE.has(id),
  )

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
            return provider?.envKey && (providerKeys[id] ?? '').trim().length > 0
          })
          .map((id) => {
            const provider = PROVIDER_MAP[id]
            return (
              <div key={id} className="review-item">
                <span className="review-label">{provider.name} Key</span>
                <span className="review-value mono">
                  {maskKey(providerKeys[id])}
                </span>
              </div>
            )
          })}

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
              {EMBEDDING_PROVIDERS.find((ep) => ep.id === embeddingProvider)?.name ?? embeddingProvider}
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
