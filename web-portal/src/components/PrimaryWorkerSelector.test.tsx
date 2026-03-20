import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PrimaryWorkerSelectorSurface } from './PrimaryWorkerSelector'

describe('PrimaryWorkerSelectorSurface', () => {
  it('renders the active provider and nested model choices', () => {
    const html = renderToStaticMarkup(
      <PrimaryWorkerSelectorSurface
        providers={[
          {
            name: 'Claude',
            configured: true,
            models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6-20250514'],
            contextWindow: 1000000,
            thinkingSupported: true,
          },
        ]}
        active={{ provider: 'Claude', model: 'claude-sonnet-4-6-20250514' }}
        open
        loading={false}
        modelsLoading={false}
        expandedProvider="Claude"
        onToggleOpen={() => {}}
        onProviderClick={() => {}}
        onModelSelect={() => {}}
      />,
    )

    expect(html).toContain('Claude/claude-sonnet-4-6-20250514')
    expect(html).toContain('Claude')
    expect(html).toContain('claude-haiku-4-5-20251001')
    expect(html).toContain('claude-sonnet-4-6-20250514')
  })
})
