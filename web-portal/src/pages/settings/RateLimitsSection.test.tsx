import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '../../i18n'
import RateLimitsSection from './RateLimitsSection'

// Raw-fetch pattern: a failed GET previously hit `.catch(() => {})` and showed
// zeroed defaults (looks like real config). It now surfaces an error state.
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RateLimitsSection', () => {
  it('surfaces an error state when the config fetch fails instead of zeroed defaults', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    render(<RateLimitsSection />)
    expect(await screen.findByText(/load this section/i)).toBeTruthy()
  })
})
