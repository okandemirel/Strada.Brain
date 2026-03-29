import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import BudgetSection from './BudgetSection'

vi.mock('../../hooks/use-api', () => ({
  useBudget: () => ({
    data: {
      global: {
        daily: { usedUsd: 3.5, limitUsd: 10, pct: 0.35 },
        monthly: { usedUsd: 18.5, limitUsd: 150, pct: 0.123 },
      },
      breakdown: { daemon: 1.2, agents: 1.8, chat: 0.4, verification: 0.1 },
      subLimitStatus: { daemonExceeded: false, agentExceeded: {} },
      config: {
        dailyLimitUsd: 10, monthlyLimitUsd: 150, warnPct: 0.8,
        subLimits: { daemonDailyUsd: 5, agentDefaultUsd: 2, verificationPct: 15 },
      },
    },
    isLoading: false,
  }),
  useBudgetHistory: () => ({ data: { entries: [] } }),
}))

function Wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

describe('BudgetSection', () => {
  it('renders budget overview', () => {
    render(<BudgetSection />, { wrapper: Wrapper })
    expect(screen.getByText('Budget')).toBeTruthy()
    expect(screen.getByText('Daily Budget')).toBeTruthy()
    expect(screen.getByText('Monthly Budget')).toBeTruthy()
  })

  it('shows breakdown categories', () => {
    render(<BudgetSection />, { wrapper: Wrapper })
    expect(screen.getByText('daemon')).toBeTruthy()
    expect(screen.getByText('agents')).toBeTruthy()
    expect(screen.getByText('chat')).toBeTruthy()
    expect(screen.getByText('verification')).toBeTruthy()
  })

  it('displays daily usage text', () => {
    render(<BudgetSection />, { wrapper: Wrapper })
    expect(screen.getByText('$3.50 used today')).toBeTruthy()
  })
})
