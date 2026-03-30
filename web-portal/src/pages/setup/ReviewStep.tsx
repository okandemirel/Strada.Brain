import { useTranslation } from 'react-i18next'
import { PRESETS, EMBEDDING_CAPABLE, EMBEDDING_PROVIDERS, PROVIDER_MAP } from '../../types/setup-constants'
import type { SaveStatus } from '../../types/setup'
import { buildSetupRetryHref } from '../../../../src/common/setup-state.ts'

interface ReviewStepProps {
  selectedPreset: string | null
  checkedProviders: Set<string>
  providerKeys: Record<string, string>
  providerAuthModes: Record<string, string>
  providerModels: Record<string, string>
  projectPath: string
  channel: string
  language: string
  ragEnabled: boolean
  embeddingProvider: string
  globalDailyBudget: number
  daemonEnabled: boolean
  daemonBudget: number
  autonomyEnabled: boolean
  autonomyHours: number
  saveStatus: SaveStatus
  saveError: string | null
  saveWarning: string | null
  bootstrapDetail: string | null
  readyUrl: string | null
  saveCommitted: boolean
  canSave: boolean
  saveBlockingReason: string | null
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
  providerModels,
  projectPath,
  channel,
  language,
  ragEnabled,
  embeddingProvider,
  globalDailyBudget,
  daemonEnabled,
  daemonBudget,
  autonomyEnabled,
  autonomyHours,
  saveStatus,
  saveError,
  saveWarning,
  bootstrapDetail,
  readyUrl,
  saveCommitted,
  canSave,
  saveBlockingReason,
  onBack,
  onSave,
}: ReviewStepProps) {
  const { t } = useTranslation('setup')
  const preset = PRESETS.find((p) => p.id === selectedPreset)
  const providerChain = Array.from(checkedProviders)
    .map((id) => {
      const providerName = PROVIDER_MAP[id]?.name ?? id
      const model = providerModels[id]?.trim()
      return model ? `${providerName} / ${model}` : providerName
    })
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

  const isSaving = saveStatus === 'saving' || saveStatus === 'saved' || saveStatus === 'booting'
  const isSaveDisabled = isSaving || !canSave

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
            const authModeDef = provider?.authModes?.find((mode) => mode.id === providerAuthModes[id])
              ?? provider?.authModes?.[0]
            if (authModeDef?.requiresSecret) {
              return (providerKeys[id] ?? '').trim().length > 0
            }
            return provider?.envKey ? (providerKeys[id] ?? '').trim().length > 0 : false
          })
          .map((id) => {
            const provider = PROVIDER_MAP[id]
            const authModeDef = provider?.authModes?.find((mode) => mode.id === providerAuthModes[id])
              ?? provider?.authModes?.[0]
            return (
              <div key={id} className="review-item">
                <span className="review-label">
                  {id === 'openai' && providerAuthModes.openai === 'chatgpt-subscription'
                    ? 'OpenAI Embedding Key'
                    : authModeDef?.secretLabel ?? `${provider.name} Key`}
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

        {Array.from(checkedProviders).map((id) => {
          const provider = PROVIDER_MAP[id]
          if (!provider) return null
          const model = providerModels[id]?.trim()
          return (
            <div key={`${id}-model`} className="review-item">
              <span className="review-label">{provider.name} Model</span>
              <span className="review-value mono">{model || 'Default'}</span>
            </div>
          )
        })}

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

        {checkedProviders.has('claude') && (
          <div className="review-item">
            <span className="review-label">Claude Auth</span>
            <span className="review-value">
              {providerAuthModes.claude === 'claude-subscription'
                ? 'Claude subscription token'
                : 'API key'}
            </span>
          </div>
        )}

        {checkedProviders.has('claude') && providerAuthModes.claude === 'claude-subscription' && (
          <div className="review-item">
            <span className="review-label">Claude Subscription Warning</span>
            <span className="review-value">
              Anthropic documents claude.ai subscription auth as restricted outside Claude Code and Claude.ai. Use this mode at your own risk.
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
            {ragEnabled && !hasEmbeddingProvider && 'Blocked (no embedding provider)'}
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

        {ragEnabled && !hasEmbeddingProvider && (
          <div className="save-message error" style={{ marginTop: 0 }}>
            RAG needs a real embedding-capable provider. Add Gemini, OpenAI API key, Mistral, Together, Fireworks, Qwen, or Ollama before saving.
          </div>
        )}

        {!canSave && saveBlockingReason && (
          <div className="save-message error" style={{ marginTop: ragEnabled && !hasEmbeddingProvider ? '0.75rem' : 0 }}>
            {saveBlockingReason}
          </div>
        )}

        <div className="review-item">
          <span className="review-label">Language</span>
          <span className="review-value">{language}</span>
        </div>

        <div className="review-item">
          <span className="review-label">Daily Budget</span>
          <span className="review-value">{globalDailyBudget > 0 ? `$${globalDailyBudget.toFixed(0)}/day` : 'Unlimited'}</span>
        </div>

        <div className="review-item">
          <span className="review-label">Daemon Mode</span>
          <span className="review-value">{daemonEnabled ? `Enabled${daemonBudget > 0 ? ` (sub-limit: $${daemonBudget.toFixed(2)}/day)` : ''}` : 'Disabled'}</span>
        </div>

        <div className="review-item">
          <span className="review-label">Autonomy</span>
          <span className="review-value">{autonomyEnabled ? `Enabled (${autonomyHours}h)` : 'Disabled'}</span>
        </div>
      </div>

      {saveStatus === 'saved' && (
        <div className="save-message polling">
          {bootstrapDetail ?? 'Configuration accepted. Starting Strada on this same URL.'}
        </div>
      )}

      {saveStatus !== 'error' && saveWarning && (
        <div className="save-message polling">
          {saveWarning}
        </div>
      )}

      {saveStatus === 'booting' && (
        <div className="save-message polling">
          {bootstrapDetail ?? 'Strada is still starting the main web app.'}
          {readyUrl && (
            <>
              {' '}
              If this page does not advance, open <a href={readyUrl}>{readyUrl}</a>.
            </>
          )}
        </div>
      )}

      {saveStatus === 'success' && (
        <div className="save-message success">
          {bootstrapDetail ?? 'Configuration saved. Redirecting...'} If this is a source checkout,
          run `./strada install-command` once before expecting the bare `strada` command to exist globally.
        </div>
      )}

      {saveStatus === 'error' && saveError && (
        <div className="save-message error">
          {saveError}
          {readyUrl && (
            <>
              {' '}
              <a href={readyUrl}>Open main app</a>
            </>
          )}
          {saveCommitted && (
            <>
              {' '}
              <a href={buildSetupRetryHref()}>Re-open setup</a>
            </>
          )}
        </div>
      )}

      <div className="step-actions">
        <button className="btn btn-secondary" onClick={onBack} disabled={isSaving}>
          Back
        </button>
        <button className="btn btn-primary" onClick={onSave} disabled={isSaveDisabled}>
          {isSaving ? 'Saving...' : 'Save Configuration'}
        </button>
      </div>
    </div>
  )
}
