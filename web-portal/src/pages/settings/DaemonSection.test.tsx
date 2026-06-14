import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../../i18n'
import DaemonSection from './DaemonSection'

// Loading-only pattern (shared by Daemon/Agents/Persona): the hook exposes
// `error`, which the section now renders instead of an endless loader.
vi.mock('../../hooks/use-api', () => ({
  useDaemon: () => ({ data: undefined, isLoading: false, error: new Error('boom') }),
}))

function Wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

describe('DaemonSection', () => {
  it('renders an error state (not an endless loader) when the fetch fails', () => {
    render(<DaemonSection />, { wrapper: Wrapper })
    expect(screen.getByText(/load this section/i)).toBeTruthy()
    expect(screen.getByText('boom')).toBeTruthy()
  })
})
