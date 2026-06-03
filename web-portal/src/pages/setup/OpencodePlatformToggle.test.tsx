import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import OpencodePlatformToggle from './OpencodePlatformToggle'

describe('OpencodePlatformToggle', () => {
  it('renders both Zen and Go options', () => {
    render(<OpencodePlatformToggle value="zen" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: /zen/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /go/i })).toBeInTheDocument()
  })

  it('reflects the value prop as the selected option', () => {
    render(<OpencodePlatformToggle value="go" onChange={() => {}} />)
    const goButton = screen.getByRole('button', { name: /go/i })
    const zenButton = screen.getByRole('button', { name: /zen/i })
    expect(goButton.getAttribute('aria-pressed')).toBe('true')
    expect(zenButton.getAttribute('aria-pressed')).toBe('false')
  })

  it('calls onChange with the chosen platform when Go is clicked', () => {
    const onChange = vi.fn()
    render(<OpencodePlatformToggle value="zen" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /go/i }))
    expect(onChange).toHaveBeenCalledWith('go')
  })

  it('calls onChange with zen when Zen is clicked while on Go', () => {
    const onChange = vi.fn()
    render(<OpencodePlatformToggle value="go" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /zen/i }))
    expect(onChange).toHaveBeenCalledWith('zen')
  })
})
