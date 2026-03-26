import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ActivityEntry } from '../../stores/monitor-store'

let mockActivities: ActivityEntry[] = []

vi.mock('../../stores/monitor-store', () => ({
  useMonitorStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { activities: mockActivities }
    return selector ? selector(state) : state
  },
}))

import ActivityFeed from './ActivityFeed'

describe('ActivityFeed', () => {
  beforeEach(() => {
    mockActivities = []
    // Mock scrollIntoView for jsdom
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('shows empty message when no activities', () => {
    render(<ActivityFeed />)
    expect(screen.getByText('No activity yet.')).toBeInTheDocument()
  })

  it('renders activity entries', () => {
    mockActivities = [
      { action: 'tool_execute', tool: 'read', detail: 'Reading config.ts', timestamp: 1000 },
      { action: 'tool_execute', tool: 'write', detail: 'Writing output.ts', timestamp: 2000 },
    ]
    render(<ActivityFeed />)
    expect(screen.getByText('Reading config.ts')).toBeInTheDocument()
    expect(screen.getByText('Writing output.ts')).toBeInTheDocument()
  })

  it('shows timestamps for each entry', () => {
    const ts = new Date(2026, 2, 23, 14, 30, 0).getTime()
    mockActivities = [
      { action: 'test', detail: 'Test entry', timestamp: ts },
    ]
    render(<ActivityFeed />)
    // toLocaleTimeString output varies by locale, just verify a time element exists
    const timeText = new Date(ts).toLocaleTimeString()
    expect(screen.getByText(timeText)).toBeInTheDocument()
  })

  it('renders multiple entries in order', () => {
    mockActivities = [
      { action: 'a', detail: 'First', timestamp: 1 },
      { action: 'b', detail: 'Second', timestamp: 2 },
      { action: 'c', detail: 'Third', timestamp: 3 },
    ]
    render(<ActivityFeed />)
    const allText = screen.getByText('First').closest('.overflow-y-auto')?.textContent ?? ''
    expect(allText.indexOf('First')).toBeLessThan(allText.indexOf('Second'))
    expect(allText.indexOf('Second')).toBeLessThan(allText.indexOf('Third'))
  })

  it('does not show empty message when activities exist', () => {
    mockActivities = [
      { action: 'test', detail: 'Has content', timestamp: 1000 },
    ]
    render(<ActivityFeed />)
    expect(screen.queryByText('No activity yet.')).not.toBeInTheDocument()
  })
})
