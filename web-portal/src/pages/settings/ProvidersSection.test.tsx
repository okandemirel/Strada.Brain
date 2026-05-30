import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../../i18n'
import ProvidersSection from './ProvidersSection'

// Identity-gated pattern (shared by Providers/Routing/Advanced): the section had
// no error branch and rendered empty chrome on failure. It now shows an error
// state once the (enabled) query fails.
vi.mock('../../hooks/useWS', () => ({
  useWS: () => ({ sessionId: 's1', profileId: 'p1' }),
}))
vi.mock('../../hooks/use-api', () => ({
  useProviders: () => ({ data: undefined, error: new Error('boom') }),
  useRagStatus: () => ({ data: undefined }),
}))

function Wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

describe('ProvidersSection', () => {
  it('renders an error state instead of empty chrome when the providers query fails', () => {
    render(<ProvidersSection />, { wrapper: Wrapper })
    expect(screen.getByText(/load this section/i)).toBeTruthy()
    expect(screen.getByText('boom')).toBeTruthy()
  })
})
