import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  PRESETS,
  PROVIDERS,
  getDefaultProviderModel,
  getOpencodeBaseUrl,
  getProviderModelOptions,
  type OpencodePlatform,
  type ProviderModelOption,
} from '../../types/setup-constants'
import type { OpenAiSubscriptionState, ClaudeSubscriptionState } from '../../hooks/useSetupWizard'
import OpencodePlatformToggle from './OpencodePlatformToggle'

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
  opencodePlatform: OpencodePlatform
  setOpencodePlatform: (platform: OpencodePlatform) => void
  openaiSubscription: OpenAiSubscriptionState
  signInWithChatGpt: () => Promise<void>
  refreshOpenAiSubscriptionStatus: () => Promise<boolean>
  claudeSubscription: ClaudeSubscriptionState
  signInWithClaude: () => Promise<void>
  refreshClaudeSubscriptionStatus: () => Promise<boolean>
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
  const { t } = useTranslation('setup')
  return (
    <div className="preset-grid">
      {PRESETS.map((preset) => (
        <div
          key={preset.id}
          className={`preset-card${selectedPreset === preset.id ? ' selected' : ''}`}
          onClick={() => selectPreset(preset.id)}
        >
          <div className="preset-name">{t(`providers.presets.${preset.id}.name`)}</div>
          <div className="preset-cost">{t(`providers.presets.${preset.id}.cost`)}</div>
          <div className="preset-desc">{t(`providers.presets.${preset.id}.desc`)}</div>
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
  const { t } = useTranslation('setup')
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
            <span className="provider-name">{t(`providers.providerNames.${provider.id}`)}</span>
            {provider.recommended && (
              <span className="provider-badge">{t('providers.recommended')}</span>
            )}
            {provider.embeddingRecommended && (
              <span className="provider-badge provider-badge-embedding">
                {t('providers.embeddingRecommended')}
              </span>
            )}
          </div>
        </label>
      ))}
    </div>
  )
}

const TIER_KEYS: Record<string, string> = {
  budget: 'providers.tier.budget',
  standard: 'providers.tier.standard',
  premium: 'providers.tier.premium',
}

/**
 * Merge live model ids with the static catalog so curated metadata (tier,
 * pricing, context window) is preserved for known models, while unknown live
 * models still render with a sensible default descriptor.
 */
function mergeLiveModels(providerId: string, modelIds: string[]): ProviderModelOption[] {
  const staticOptions = getProviderModelOptions(providerId)
  return modelIds.map((modelId) => {
    const staticOpt = staticOptions.find((o) => o.model === modelId)
    if (staticOpt) return staticOpt
    return {
      model: modelId,
      label: modelId.split('/').pop() ?? modelId,
      tier: 'standard' as const,
      inputPer1M: 0,
      outputPer1M: 0,
      contextWindow: 'unknown',
      notes: 'Auto-discovered model',
    }
  })
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
  opencodePlatform,
  setOpencodePlatform,
  openaiSubscription,
  signInWithChatGpt,
  refreshOpenAiSubscriptionStatus,
  claudeSubscription,
  signInWithClaude,
  refreshClaudeSubscriptionStatus,
  onNext,
  onBack,
}: ProvidersStepProps) {
  const { t } = useTranslation('setup')
  const [liveModels, setLiveModels] = useState<Map<string, ProviderModelOption[]>>(new Map())

  // Probe each enabled+keyed provider's live model list via POST (key in body,
  // never the URL). Debounced per-provider so typing a key doesn't flood the
  // endpoint. OpenCode is re-probed at the chosen platform's base URL. Empty
  // results / failures simply leave the provider absent from `liveModels`, so the
  // UI falls back to the static catalog.
  const PROBE_DEBOUNCE_MS = 400
  const probeKeyRef = useRef<Record<string, string>>({})

  useEffect(() => {
    const timers: Array<ReturnType<typeof setTimeout>> = []

    for (const provider of PROVIDERS) {
      if (!checkedProviders.has(provider.id)) continue
      const key = (providerKeys[provider.id] ?? '').trim()
      if (!key) continue

      const baseUrl = provider.id === 'opencode' ? getOpencodeBaseUrl(opencodePlatform) : undefined
      // Re-probe whenever the key or (for OpenCode) the base URL changes.
      const probeSignature = `${key}::${baseUrl ?? ''}`
      if (probeKeyRef.current[provider.id] === probeSignature) continue

      const providerId = provider.id
      const timer = setTimeout(() => {
        probeKeyRef.current[providerId] = probeSignature
        const body: { provider: string; key: string; baseUrl?: string } = { provider: providerId, key }
        if (baseUrl) body.baseUrl = baseUrl

        fetch('/api/providers/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            return res.json()
          })
          .then((data: { providers?: Array<{ name: string; models: string[] }> }) => {
            // Ignore a stale response: a newer probe (different key/baseUrl) for
            // this provider has since superseded this one, so don't clobber it.
            if (probeKeyRef.current[providerId] !== probeSignature) return
            const match = data.providers?.find((p) => p.name === providerId)
            setLiveModels((prev) => {
              const next = new Map(prev)
              if (match && match.models.length > 0) {
                next.set(providerId, mergeLiveModels(providerId, match.models))
              } else {
                // Empty result: drop any stale live list so we fall back to static.
                next.delete(providerId)
              }
              return next
            })
          })
          .catch((err) => {
            // Ignore a stale failure: a newer probe has superseded this one, so
            // don't reset its signature or drop its (possibly good) live list.
            if (probeKeyRef.current[providerId] !== probeSignature) return
            console.error(`[ProvidersStep] live model probe failed for ${providerId}:`, err)
            // Allow a later retry after a transient failure.
            delete probeKeyRef.current[providerId]
            setLiveModels((prev) => {
              if (!prev.has(providerId)) return prev
              const next = new Map(prev)
              next.delete(providerId)
              return next
            })
          })
      }, PROBE_DEBOUNCE_MS)
      timers.push(timer)
    }

    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  }, [checkedProviders, providerKeys, opencodePlatform])

  // On mount, fetch the server's WARM live-model list. The backend GET sources
  // provider keys from its OWN environment (e.g. re-running setup over an
  // existing .env), so it can return CURRENT models for already-configured
  // providers before the user types anything. Seed those into `liveModels` so the
  // live set shows on first paint; a later per-key POST probe still takes
  // precedence (we don't clobber an entry a probe has already set). Best-effort:
  // on failure the static fallback list simply remains.
  useEffect(() => {
    let cancelled = false
    fetch('/api/providers/models', { method: 'GET' })
      .then((res) => (res.ok ? res.json() : { providers: [] }))
      .then((data: { providers?: Array<{ name: string; models: string[] }> }) => {
        if (cancelled) return
        const warm = (data.providers ?? []).filter((p) => p.models?.length > 0)
        if (warm.length === 0) return
        setLiveModels((prev) => {
          const next = new Map(prev)
          for (const p of warm) {
            if (!next.has(p.name)) next.set(p.name, mergeLiveModels(p.name, p.models))
          }
          return next
        })
      })
      .catch(() => {
        // Best-effort warm: keep the static fallback on any failure.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const isLiveProvider = (providerId: string): boolean => liveModels.has(providerId)

  const getModelsForProvider = (providerId: string): ProviderModelOption[] => {
    return liveModels.get(providerId) ?? getProviderModelOptions(providerId)
  }

  const providerSettingsProviders = PROVIDERS.filter((p) => checkedProviders.has(p.id))

  return (
    <div className="step">
      <h2>{t('providers.title')}</h2>
      <p className="step-subtitle">
        {t('providers.subtitle')}
      </p>

      <PresetGrid selectedPreset={selectedPreset} selectPreset={selectPreset} />

      <h3 className="section-label">{t('providers.sectionProviders')}</h3>
      <ProviderGrid
        checkedProviders={checkedProviders}
        toggleProvider={toggleProvider}
      />

      {providerSettingsProviders.length > 0 && (
        <div className="provider-keys">
          <h3 className="section-label">{t('providers.sectionAccess')}</h3>
          {providerSettingsProviders.map((provider) => {
            const modelOptions = getModelsForProvider(provider.id)
            const selectedAuthMode = providerAuthModes[provider.id] ?? provider.authModes?.[0]?.id ?? 'api-key'
            const selectedAuthModeDef = provider.authModes?.find((mode) => mode.id === selectedAuthMode)
            const usingOpenAISubscription = provider.id === 'openai' && selectedAuthMode === 'chatgpt-subscription'
            const usingClaudeSubscription = provider.id === 'claude' && selectedAuthMode === 'claude-subscription'
            const showsCredentialField = selectedAuthModeDef?.requiresSecret ?? (provider.envKey !== null && !usingOpenAISubscription)
            const selectedModel = providerModels[provider.id] ?? getDefaultProviderModel(provider.id) ?? ''
            const helpUrl = selectedAuthModeDef?.helpUrl ?? provider.helpUrl
            const helpLabel = selectedAuthModeDef?.helpLabel ?? t('providers.getKey')

            return (
              <div key={provider.id} className="provider-key-field">
                <div className="provider-access-header">
                  <div>
                    <div className="provider-access-name">{t(`providers.providerNames.${provider.id}`)}</div>
                    <div className="provider-access-summary">
                      {t('providers.accessSummary')}
                    </div>
                  </div>
                  {selectedModel && (
                    <div className="provider-access-pill">{selectedModel}</div>
                  )}
                </div>

                {provider.authModes && provider.authModes.length > 1 && (
                  <div className="provider-choice-group">
                    <div className="provider-field-label">{t('providers.accessMode')}</div>
                    <div className="provider-auth-grid">
                    {provider.authModes.map((mode) => {
                      const modeKeySegment = mode.id === 'api-key' ? 'apiKey' : mode.id === 'chatgpt-subscription' ? 'chatgptSubscription' : mode.id === 'claude-subscription' ? 'subscription' : mode.id
                      return (
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
                          <span className="provider-choice-title">{t(`providers.authModes.${provider.id}.${modeKeySegment}.label`)}</span>
                          <span className="provider-choice-copy">{t(`providers.authModes.${provider.id}.${modeKeySegment}.description`)}</span>
                        </button>
                      )
                    })}
                    </div>
                  </div>
                )}

                {provider.id === 'opencode' && (
                  <OpencodePlatformToggle
                    value={opencodePlatform}
                    onChange={setOpencodePlatform}
                  />
                )}

                <div className="provider-choice-group">
                  <div className="provider-field-label">
                    {t('providers.defaultModel')}
                    <span
                      className={`provider-model-source provider-model-source-${isLiveProvider(provider.id) ? 'live' : 'static'}`}
                    >
                      {isLiveProvider(provider.id)
                        ? t('providers.modelSource.live', { defaultValue: 'live' })
                        : t('providers.modelSource.static', { defaultValue: 'default list' })}
                    </span>
                  </div>
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
                              {t(TIER_KEYS[option.tier] ?? option.tier)}
                            </span>
                          </div>
                          <div className="provider-model-id">{option.model}</div>
                          <div className="provider-model-stats">
                            <span>{option.contextWindow}</span>
                            <span>{t('providers.modelStats.in', { amount: option.inputPer1M.toFixed(2) })}</span>
                            <span>{t('providers.modelStats.out', { amount: option.outputPer1M.toFixed(2) })}</span>
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
                      placeholder={getDefaultProviderModel(provider.id) ?? t('providers.modelPlaceholder')}
                      onChange={(e) => setProviderModel(provider.id, e.target.value)}
                      autoComplete="off"
                    />
                  )}
                </div>

                {showsCredentialField && (
                  <>
                    <label htmlFor={`key-${provider.id}`}>
                      {(() => {
                        const modeKeySegment = selectedAuthMode === 'api-key' ? 'apiKey' : selectedAuthMode === 'chatgpt-subscription' ? 'chatgptSubscription' : selectedAuthMode === 'claude-subscription' ? 'subscription' : selectedAuthMode
                        const secretLabelKey = `providers.authModes.${provider.id}.${modeKeySegment}.secretLabel`
                        return t(secretLabelKey, { defaultValue: selectedAuthModeDef?.secretLabel ?? t(`providers.providerNames.${provider.id}`) })
                      })()}
                      {helpUrl && (
                        <a
                          href={helpUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="key-help-link"
                        >
                          {(() => {
                            const modeKeySegment = selectedAuthMode === 'api-key' ? 'apiKey' : selectedAuthMode === 'chatgpt-subscription' ? 'chatgptSubscription' : selectedAuthMode === 'claude-subscription' ? 'subscription' : selectedAuthMode
                            const helpLabelKey = `providers.authModes.${provider.id}.${modeKeySegment}.helpLabel`
                            return t(helpLabelKey, { defaultValue: helpLabel })
                          })()}
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
                  <div className="provider-helper-copy provider-chatgpt-signin">
                    {openaiSubscription.codexAvailable === false ? (
                      <p className="warning">
                        {openaiSubscription.error
                          ?? t('providers.openai.codexMissing', {
                            defaultValue: 'Codex CLI not found. Install it with `npm install -g @openai/codex`, then sign in.',
                          })}
                      </p>
                    ) : (
                      <>
                        <div className={`signin-status signin-status-${openaiSubscription.status}`}>
                          {openaiSubscription.status === 'connected' ? (
                            <span className="signin-badge connected">
                              ✓ {t('providers.openai.signedIn', { defaultValue: 'Signed in with ChatGPT' })}
                              {openaiSubscription.expiresAt
                                ? ` · ${t('providers.openai.validUntil', { defaultValue: 'valid until' })} ${new Date(openaiSubscription.expiresAt).toLocaleString()}`
                                : ''}
                            </span>
                          ) : openaiSubscription.status === 'checking' ? (
                            <span className="signin-badge checking">
                              {t('providers.openai.checking', { defaultValue: 'Checking ChatGPT session…' })}
                            </span>
                          ) : openaiSubscription.status === 'signing-in' ? (
                            <span className="signin-badge signing-in">
                              {t('providers.openai.waitingBrowser', { defaultValue: 'Waiting for sign-in in your browser…' })}
                            </span>
                          ) : (
                            <span className="signin-badge disconnected">
                              {t('providers.openai.notSignedIn', { defaultValue: 'Not signed in' })}
                            </span>
                          )}
                        </div>

                        <div className="signin-actions">
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => { void signInWithChatGpt() }}
                            disabled={openaiSubscription.status === 'signing-in' || openaiSubscription.status === 'checking'}
                          >
                            {openaiSubscription.status === 'connected'
                              ? t('providers.openai.signInAgain', { defaultValue: 'Sign in again' })
                              : t('providers.openai.signIn', { defaultValue: 'Sign in with ChatGPT' })}
                          </button>
                          {(openaiSubscription.status === 'signing-in' || openaiSubscription.status === 'disconnected') && (
                            <button
                              type="button"
                              className="btn btn-secondary"
                              onClick={() => { void refreshOpenAiSubscriptionStatus() }}
                            >
                              {t('providers.openai.refresh', { defaultValue: 'Refresh' })}
                            </button>
                          )}
                        </div>

                        {openaiSubscription.status === 'signing-in' && openaiSubscription.authUrl && (
                          <p className="signin-help">
                            {t('providers.openai.browserHint', { defaultValue: "If your browser didn't open, " })}
                            <a href={openaiSubscription.authUrl} target="_blank" rel="noopener noreferrer">
                              {t('providers.openai.openLink', { defaultValue: 'open the sign-in page' })}
                            </a>
                            .
                          </p>
                        )}

                        {openaiSubscription.error && openaiSubscription.status !== 'connected' && (
                          <p className="warning">{openaiSubscription.error}</p>
                        )}

                        <p className="signin-note">
                          {t('providers.openai.embeddingsNote', {
                            defaultValue: 'OpenAI embeddings still require an OpenAI API key.',
                          })}
                        </p>
                      </>
                    )}
                  </div>
                )}

                {usingClaudeSubscription && (
                  <div className="provider-helper-copy provider-claude-signin">
                    {claudeSubscription.claudeAvailable === false ? (
                      <p className="warning">
                        {claudeSubscription.error
                          ?? t('providers.claude.cliMissing', {
                            defaultValue: 'Claude CLI not found. Install it with `npm install -g @anthropic-ai/claude-code`, then sign in.',
                          })}
                      </p>
                    ) : (
                      <>
                        <div className={`signin-status signin-status-${claudeSubscription.status}`}>
                          {claudeSubscription.status === 'connected' ? (
                            <span className="signin-badge connected">
                              ✓ {t('providers.claude.signedIn', { defaultValue: 'Signed in with Claude' })}
                            </span>
                          ) : claudeSubscription.status === 'checking' ? (
                            <span className="signin-badge checking">
                              {t('providers.claude.checking', { defaultValue: 'Checking Claude session…' })}
                            </span>
                          ) : claudeSubscription.status === 'signing-in' ? (
                            <span className="signin-badge signing-in">
                              {t('providers.claude.waitingBrowser', { defaultValue: 'Waiting for sign-in in your browser…' })}
                            </span>
                          ) : (
                            <span className="signin-badge disconnected">
                              {t('providers.claude.notSignedIn', { defaultValue: 'Not signed in' })}
                            </span>
                          )}
                        </div>

                        <div className="signin-actions">
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => { void signInWithClaude() }}
                            disabled={claudeSubscription.status === 'signing-in' || claudeSubscription.status === 'checking'}
                          >
                            {claudeSubscription.status === 'connected'
                              ? t('providers.claude.signInAgain', { defaultValue: 'Sign in again' })
                              : t('providers.claude.signIn', { defaultValue: 'Sign in with Claude' })}
                          </button>
                          {(claudeSubscription.status === 'signing-in' || claudeSubscription.status === 'disconnected') && (
                            <button
                              type="button"
                              className="btn btn-secondary"
                              onClick={() => { void refreshClaudeSubscriptionStatus() }}
                            >
                              {t('providers.claude.refresh', { defaultValue: 'Refresh' })}
                            </button>
                          )}
                        </div>

                        {claudeSubscription.status === 'signing-in' && claudeSubscription.authUrl && (
                          <p className="signin-help">
                            {t('providers.claude.browserHint', { defaultValue: "If your browser didn't open, " })}
                            <a href={claudeSubscription.authUrl} target="_blank" rel="noopener noreferrer">
                              {t('providers.claude.openLink', { defaultValue: 'open the sign-in page' })}
                            </a>
                            .
                          </p>
                        )}

                        {claudeSubscription.error && claudeSubscription.status !== 'connected' && (
                          <p className="warning">{claudeSubscription.error}</p>
                        )}

                        <p className="signin-note">
                          {t('providers.claude.tokenStep', {
                            defaultValue: 'Step 2: after signing in, run `claude setup-token` in a terminal and paste the generated token below.',
                          })}
                        </p>
                      </>
                    )}

                    <p>
                      {t('providers.claude.subscriptionInfo')}
                    </p>
                    <p className="warning">
                      {t('providers.claude.subscriptionWarning')}
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
          {t('wizard.nav.back')}
        </button>
        <button className="btn btn-primary" onClick={onNext}>
          {t('wizard.nav.next')}
        </button>
      </div>
    </div>
  )
}
