import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import ToastContainer from './Toast'

describe('ToastContainer (stub)', () => {
  it('renders null without error', () => {
    const { container } = render(<ToastContainer />)
    expect(container.innerHTML).toBe('')
  })
})
