import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Mock workspace store
const mockSetMode = vi.fn()
let mockMode = 'chat'
vi.mock('../../stores/workspace-store', () => ({
  useWorkspaceStore: (selector?: (s: { mode: string; setMode: (m: string) => void }) => unknown) => {
    const state = { mode: mockMode, setMode: mockSetMode }
    return selector ? selector(state) : state
  },
}))

import BottomTabBar from './BottomTabBar'

describe('BottomTabBar', () => {
  beforeEach(() => {
    mockMode = 'chat'
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders 4 mode tabs', () => {
    render(<BottomTabBar />)
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(4)
  })

  it('Chat tab label is visible', () => {
    render(<BottomTabBar />)
    expect(screen.getByText('Chat')).toBeInTheDocument()
  })

  it('Chat tab is active by default (has accent class)', () => {
    render(<BottomTabBar />)
    const chatBtn = screen.getByText('Chat').closest('button')
    expect(chatBtn?.className).toContain('text-accent')
  })

  it('clicking Chat tab calls setMode with "chat"', async () => {
    const user = userEvent.setup()
    render(<BottomTabBar />)
    const chatBtn = screen.getByText('Chat').closest('button')!
    await user.click(chatBtn)
    expect(mockSetMode).toHaveBeenCalledWith('chat')
  })

  it('all tabs (Chat, Monitor, Canvas, Code) are enabled', () => {
    render(<BottomTabBar />)
    const monitorBtn = screen.getByText('Monitor').closest('button')
    const canvasBtn = screen.getByText('Canvas').closest('button')
    const codeBtn = screen.getByText('Code').closest('button')
    expect(monitorBtn).not.toBeDisabled()
    expect(canvasBtn).not.toBeDisabled()
    expect(codeBtn).not.toBeDisabled()
  })

  it('clicking Code tab calls setMode with "code"', async () => {
    const user = userEvent.setup()
    render(<BottomTabBar />)
    const codeBtn = screen.getByText('Code').closest('button')!
    await user.click(codeBtn)
    expect(mockSetMode).toHaveBeenCalledWith('code')
  })
})
