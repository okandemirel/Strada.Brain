import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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
    render(
      <ConfirmDialog
        confirmation={{
          confirmId: 'confirm-1',
          question: '**Plan: Review release**\n1. Check lint\n2. Ship build',
          options: ['Approve (Recommended)', 'Modify'],
        }}
        onRespond={() => {}}
      />,
    )

    expect(screen.getByText('Plan: Review release')).toBeDefined()
    expect(screen.getByText('Check lint')).toBeDefined()
    expect(screen.getByText('Ship build')).toBeDefined()
    expect(screen.getByText('Recommended')).toBeDefined()
  })

  it('renders the default empty state copy', () => {
    const html = renderToStaticMarkup(<EmptyState />)
    expect(html).toContain('Strada.Brain')
    expect(html).toContain('AI-powered Unity development assistant')
  })
})
