import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ConfirmDialog from './ConfirmDialog'
import EmptyState from './EmptyState'

describe('portal smoke', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue(null),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders plan confirmations as structured steps', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        confirmation={{
          confirmId: 'confirm-1',
          question: '**Plan: Review release**\n1. Check lint\n2. Ship build',
          options: ['Approve (Recommended)', 'Modify'],
        }}
        onRespond={() => {}}
      />,
    )

    expect(html).toContain('Plan: Review release')
    expect(html).toContain('Check lint')
    expect(html).toContain('Ship build')
    expect(html).toContain('Recommended')
  })

  it('renders the default empty state copy', () => {
    const html = renderToStaticMarkup(<EmptyState />)
    expect(html).toContain('Strada.Brain')
    expect(html).toContain('AI-powered Unity development assistant')
  })
})
