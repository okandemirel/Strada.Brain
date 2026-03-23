import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import ToastContainer from './Toast'

describe('ToastContainer', () => {
  beforeEach(() => {
    useWorkspaceStore.getState().reset()
    vi.useRealTimers()
  })

  it('renders nothing when no notifications', () => {
    const { container } = render(<ToastContainer />)
    expect(container.innerHTML).toBe('')
  })

  it('renders notification with title and message', () => {
    useWorkspaceStore.getState().addNotification({
      title: 'Build Complete',
      message: 'Project compiled successfully',
      severity: 'info',
    })

    render(<ToastContainer />)

    expect(screen.getByText('Build Complete')).toBeInTheDocument()
    expect(screen.getByText('Project compiled successfully')).toBeInTheDocument()
  })

  it('renders severity classes (info, warning, error)', () => {
    useWorkspaceStore.getState().addNotification({
      title: 'Info',
      message: 'info msg',
      severity: 'info',
    })
    useWorkspaceStore.getState().addNotification({
      title: 'Warning',
      message: 'warn msg',
      severity: 'warning',
    })
    useWorkspaceStore.getState().addNotification({
      title: 'Error',
      message: 'error msg',
      severity: 'error',
    })

    render(<ToastContainer />)

    const infoEl = screen.getByText('Info').closest('div[class*="border"]')!
    expect(infoEl.className).toContain('border-accent/40')
    expect(infoEl.className).toContain('bg-accent/10')

    const warnEl = screen.getByText('Warning').closest('div[class*="border"]')!
    expect(warnEl.className).toContain('border-yellow-500/40')
    expect(warnEl.className).toContain('bg-yellow-500/10')

    const errEl = screen.getByText('Error').closest('div[class*="border"]')!
    expect(errEl.className).toContain('border-red-500/40')
    expect(errEl.className).toContain('bg-red-500/10')
  })

  it('dismiss button removes notification', () => {
    useWorkspaceStore.getState().addNotification({
      title: 'Dismissable',
      message: 'Click X to dismiss',
      severity: 'info',
    })

    render(<ToastContainer />)

    expect(screen.getByText('Dismissable')).toBeInTheDocument()

    const dismissBtn = screen.getByRole('button', { name: 'Dismiss' })
    fireEvent.click(dismissBtn)

    expect(useWorkspaceStore.getState().notifications).toHaveLength(0)
  })

  it('shows undo button for mode_suggest notifications', () => {
    useWorkspaceStore.getState().addNotification({
      kind: 'mode_suggest',
      title: 'Mode switched',
      message: 'Switched to monitor',
      severity: 'info',
    })

    render(<ToastContainer />)

    expect(screen.getByText('Undo')).toBeInTheDocument()
  })

  it('clicking undo calls undoModeSwitch and dismisses', () => {
    // Set up a mode switch so there is a previousMode to undo to
    useWorkspaceStore.getState().suggestMode('monitor')

    useWorkspaceStore.getState().addNotification({
      kind: 'mode_suggest',
      title: 'Mode switched',
      message: 'Switched to monitor',
      severity: 'info',
    })

    const undoSpy = vi.spyOn(useWorkspaceStore.getState(), 'undoModeSwitch')
    const dismissSpy = vi.spyOn(useWorkspaceStore.getState(), 'dismissNotification')

    render(<ToastContainer />)

    const undoBtn = screen.getByText('Undo')
    fireEvent.click(undoBtn)

    expect(undoSpy).toHaveBeenCalled()
    expect(dismissSpy).toHaveBeenCalled()

    undoSpy.mockRestore()
    dismissSpy.mockRestore()
  })

  it('shows max 3 notifications', () => {
    for (let i = 0; i < 5; i++) {
      useWorkspaceStore.getState().addNotification({
        title: `Notification ${i}`,
        message: `Message ${i}`,
        severity: 'info',
      })
    }

    render(<ToastContainer />)

    // Only last 3 should be visible
    expect(screen.queryByText('Notification 0')).not.toBeInTheDocument()
    expect(screen.queryByText('Notification 1')).not.toBeInTheDocument()
    expect(screen.getByText('Notification 2')).toBeInTheDocument()
    expect(screen.getByText('Notification 3')).toBeInTheDocument()
    expect(screen.getByText('Notification 4')).toBeInTheDocument()
  })

  it('auto-dismiss after timeout', () => {
    vi.useFakeTimers()

    useWorkspaceStore.getState().addNotification({
      title: 'Auto Dismiss',
      message: 'Will disappear',
      severity: 'info',
    })

    expect(useWorkspaceStore.getState().notifications).toHaveLength(1)

    render(<ToastContainer />)

    expect(screen.getByText('Auto Dismiss')).toBeInTheDocument()

    // Advance past the 5000ms auto-dismiss timeout
    vi.advanceTimersByTime(5000)

    expect(useWorkspaceStore.getState().notifications).toHaveLength(0)
  })
})
