import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import i18n from '../../i18n'
import ReviewStep from './ReviewStep'

function renderReview(overrides: Partial<React.ComponentProps<typeof ReviewStep>> = {}) {
  return renderToStaticMarkup(
    <ReviewStep
      selectedPreset={null}
      checkedProviders={new Set(['kimi'])}
      providerKeys={{ kimi: 'sk-kimi-test' }}
      providerAuthModes={{ openai: 'api-key' }}
      providerModels={{ kimi: 'kimi-for-coding' }}
      projectPath=""
      channel="web"
      language="tr"
      ragEnabled
      embeddingProvider="auto"
      globalDailyBudget={0}
      daemonEnabled={false}
      daemonBudget={1}
      autonomyEnabled={false}
      autonomyHours={4}
      saveStatus="idle"
      saveError={null}
      saveWarning={null}
      bootstrapDetail={null}
      readyUrl={null}
      saveCommitted={false}
      canSave={false}
      saveBlockingReason={null}
      onBack={() => {}}
      onSave={() => {}}
      {...overrides}
    />,
  )
}

describe('ReviewStep', () => {
  it('renders provider warnings as a non-error save state', () => {
    const html = renderToStaticMarkup(
      <ReviewStep
        selectedPreset={null}
        checkedProviders={new Set(['kimi'])}
        providerKeys={{ kimi: 'sk-kimi-test' }}
        providerAuthModes={{ openai: 'api-key' }}
        providerModels={{ kimi: 'kimi-for-coding' }}
        projectPath="/Users/test/project"
        channel="web"
        language="en"
        ragEnabled={false}
        embeddingProvider="auto"
        globalDailyBudget={0}
        daemonEnabled={false}
        daemonBudget={1}
        autonomyEnabled={false}
        autonomyHours={4}
        saveStatus="saved"
        saveError={null}
        saveWarning="Kimi (Moonshot): Kimi (Moonshot) health check failed. Verify the credential and network access."
        bootstrapDetail="Configuration accepted. Starting Strada on this same URL."
        readyUrl="http://127.0.0.1:3000/"
        saveCommitted
        canSave
        saveBlockingReason={null}
        onBack={() => {}}
        onSave={() => {}}
      />,
    )

    expect(html).toContain('Configuration accepted. Starting Strada on this same URL.')
    expect(html).toContain('Kimi (Moonshot): Kimi (Moonshot) health check failed. Verify the credential and network access.')
    expect(html).toContain('Kimi Model')
    expect(html).toContain('kimi-for-coding')
    expect(html).not.toContain('Re-open setup')
  })

  it('renders labels, values and the RAG readiness error in Turkish when the locale is tr (D38)', async () => {
    await i18n.changeLanguage('tr')
    try {
      // kimi is not embedding-capable and RAG is on: the readiness error shows.
      const html = renderReview()
      expect(html).toContain('Proje Yolu')
      expect(html).toContain('Ayarlanmadı')
      expect(html).toContain('Engellendi (gömme vektörü sağlayıcısı yok)')
      expect(html).toContain('RAG, gerçek bir gömme vektörü destekleyen sağlayıcı gerektirir')
      expect(html).not.toContain('Project Path')
      expect(html).not.toContain('RAG needs a real embedding-capable provider')
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('renders the same strings in English under the en locale (guard)', async () => {
    await i18n.changeLanguage('en')
    const html = renderReview({ saveStatus: 'saved' })
    expect(html).toContain('Project Path')
    expect(html).toContain('Not set')
    expect(html).toContain('Blocked (no embedding provider)')
    expect(html).toContain('RAG needs a real embedding-capable provider')
    expect(html).toContain('Configuration accepted. Starting Strada on this same URL.')
  })
})

describe('ReviewStep budget summary (Codex 2026-09-17 round 8 #12)', () => {
  it('reads a zero budget as a spending freeze and only a negative value as unlimited', async () => {
    await i18n.changeLanguage('en')
    // 0 used to render as "Unlimited", the exact opposite of what it means.
    const frozen = renderReview({ globalDailyBudget: 0 })
    expect(frozen).toContain('nothing may spend')
    expect(frozen).not.toContain('Unlimited')

    const unlimited = renderReview({ globalDailyBudget: -1 })
    expect(unlimited).toContain('Unlimited')
    expect(unlimited).not.toContain('nothing may spend')

    const limited = renderReview({ globalDailyBudget: 12 })
    expect(limited).toContain('$12/day')
  })
})
