import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PageEmptyState } from './page-empty-state'

describe('PageEmptyState', () => {
  it('renders title and description', () => {
    render(<PageEmptyState title="Nothing here" description="Try again later" />)
    expect(screen.getByRole('heading', { name: 'Nothing here' })).toBeTruthy()
    expect(screen.getByText('Try again later')).toBeTruthy()
  })

  it('omits description/icon/action when not provided', () => {
    const { container } = render(<PageEmptyState title="Only title" />)
    expect(screen.getByText('Only title')).toBeTruthy()
    expect(container.querySelector('p')).toBeNull()
  })

  it('renders icon and action when provided', () => {
    render(
      <PageEmptyState
        title="T"
        icon={<span data-testid="icon">i</span>}
        action={<button>Do</button>}
      />,
    )
    expect(screen.getByTestId('icon')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Do' })).toBeTruthy()
  })
})
