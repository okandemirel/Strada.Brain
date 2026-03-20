import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ReviewStep from './ReviewStep'

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
})
