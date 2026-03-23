import { describe, expect, it, beforeEach, vi } from 'vitest'
import { useWorkspaceStore } from './workspace-store'

describe('useWorkspaceStore', () => {
  beforeEach(() => {
    useWorkspaceStore.getState().reset()
  })

  it('starts in chat mode', () => {
    const state = useWorkspaceStore.getState()
    expect(state.mode).toBe('chat')
    expect(state.userOverride).toBe(false)
    expect(state.secondaryVisible).toBe(false)
    expect(state.panelSizes).toEqual({ sidebar: 15, primary: 70, secondary: 15 })
  })

  it('switches mode and sets userOverride=true', () => {
    useWorkspaceStore.getState().setMode('monitor')
    const state = useWorkspaceStore.getState()
    expect(state.mode).toBe('monitor')
    expect(state.userOverride).toBe(true)
  })

  it('suggestMode does not override when userOverride is true', () => {
    useWorkspaceStore.getState().setMode('canvas')
    useWorkspaceStore.getState().suggestMode('code')
    expect(useWorkspaceStore.getState().mode).toBe('canvas')
  })

  it('suggestMode works when userOverride is false', () => {
    useWorkspaceStore.getState().suggestMode('monitor')
    const state = useWorkspaceStore.getState()
    expect(state.mode).toBe('monitor')
    expect(state.userOverride).toBe(false)
  })

  it('resetOverride clears override and returns to chat', () => {
    useWorkspaceStore.getState().setMode('code')
    expect(useWorkspaceStore.getState().userOverride).toBe(true)

    useWorkspaceStore.getState().resetOverride()
    const state = useWorkspaceStore.getState()
    expect(state.userOverride).toBe(false)
    expect(state.mode).toBe('chat')
  })

  it('toggles secondary panel visibility', () => {
    expect(useWorkspaceStore.getState().secondaryVisible).toBe(false)

    useWorkspaceStore.getState().toggleSecondary()
    expect(useWorkspaceStore.getState().secondaryVisible).toBe(true)

    useWorkspaceStore.getState().toggleSecondary()
    expect(useWorkspaceStore.getState().secondaryVisible).toBe(false)
  })

  it('stores panel sizes', () => {
    useWorkspaceStore.getState().setPanelSizes({ sidebar: 20, primary: 60 })
    const { panelSizes } = useWorkspaceStore.getState()
    expect(panelSizes.sidebar).toBe(20)
    expect(panelSizes.primary).toBe(60)
    expect(panelSizes.secondary).toBe(15)
  })

  it('reset returns to initial state', () => {
    useWorkspaceStore.getState().setMode('code')
    useWorkspaceStore.getState().toggleSecondary()
    useWorkspaceStore.getState().setPanelSizes({ sidebar: 25 })

    useWorkspaceStore.getState().reset()

    const state = useWorkspaceStore.getState()
    expect(state.mode).toBe('chat')
    expect(state.userOverride).toBe(false)
    expect(state.secondaryVisible).toBe(false)
    expect(state.panelSizes).toEqual({ sidebar: 15, primary: 70, secondary: 15 })
  })
})

describe('useWorkspaceStore — previousMode and undo', () => {
  beforeEach(() => {
    useWorkspaceStore.getState().reset()
  })

  it('suggestMode tracks previousMode', () => {
    expect(useWorkspaceStore.getState().previousMode).toBeNull()

    useWorkspaceStore.getState().suggestMode('monitor')

    const state = useWorkspaceStore.getState()
    expect(state.mode).toBe('monitor')
    expect(state.previousMode).toBe('chat')
  })

  it('setMode tracks previousMode', () => {
    useWorkspaceStore.getState().setMode('canvas')

    const state = useWorkspaceStore.getState()
    expect(state.mode).toBe('canvas')
    expect(state.previousMode).toBe('chat')

    useWorkspaceStore.getState().setMode('code')

    const state2 = useWorkspaceStore.getState()
    expect(state2.mode).toBe('code')
    expect(state2.previousMode).toBe('canvas')
  })

  it('undoModeSwitch restores previousMode', () => {
    useWorkspaceStore.getState().suggestMode('monitor')
    expect(useWorkspaceStore.getState().mode).toBe('monitor')
    expect(useWorkspaceStore.getState().previousMode).toBe('chat')

    useWorkspaceStore.getState().undoModeSwitch()

    const state = useWorkspaceStore.getState()
    expect(state.mode).toBe('chat')
    expect(state.previousMode).toBeNull()
    expect(state.userOverride).toBe(true)
  })

  it('undoModeSwitch does nothing when previousMode is null', () => {
    expect(useWorkspaceStore.getState().previousMode).toBeNull()
    const modeBefore = useWorkspaceStore.getState().mode

    useWorkspaceStore.getState().undoModeSwitch()

    const state = useWorkspaceStore.getState()
    expect(state.mode).toBe(modeBefore)
    expect(state.previousMode).toBeNull()
  })
})

describe('useWorkspaceStore — notifications', () => {
  beforeEach(() => {
    useWorkspaceStore.getState().reset()
  })

  it('addNotification adds to notifications array', () => {
    useWorkspaceStore.getState().addNotification({
      title: 'Test',
      message: 'Hello',
      severity: 'info',
    })

    const notifications = useWorkspaceStore.getState().notifications
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('Test')
    expect(notifications[0].message).toBe('Hello')
    expect(notifications[0].severity).toBe('info')
    expect(notifications[0].id).toBeDefined()
    expect(notifications[0].timestamp).toBeDefined()
  })

  it('addNotification caps at 50', () => {
    for (let i = 0; i < 55; i++) {
      useWorkspaceStore.getState().addNotification({
        title: `N${i}`,
        message: `Msg ${i}`,
        severity: 'info',
      })
    }

    const notifications = useWorkspaceStore.getState().notifications
    expect(notifications).toHaveLength(50)
    // The first 5 should have been dropped, last one should be N54
    expect(notifications[notifications.length - 1].title).toBe('N54')
    expect(notifications[0].title).toBe('N5')
  })

  it('dismissNotification removes by id', () => {
    useWorkspaceStore.getState().addNotification({
      title: 'Keep',
      message: 'stay',
      severity: 'info',
    })
    useWorkspaceStore.getState().addNotification({
      title: 'Remove',
      message: 'go away',
      severity: 'warning',
    })

    const notifications = useWorkspaceStore.getState().notifications
    expect(notifications).toHaveLength(2)

    const removeId = notifications.find((n) => n.title === 'Remove')!.id
    useWorkspaceStore.getState().dismissNotification(removeId)

    const remaining = useWorkspaceStore.getState().notifications
    expect(remaining).toHaveLength(1)
    expect(remaining[0].title).toBe('Keep')
  })

  it('suggestMode with notification — mode_suggest dispatch adds "Mode switched" notification', () => {
    // Simulate what dispatchWorkspaceMessage does for workspace:mode_suggest
    const ws = useWorkspaceStore.getState()
    const prevMode = ws.mode
    ws.suggestMode('monitor')
    if (!ws.userOverride && 'monitor' !== prevMode) {
      ws.addNotification({
        title: 'Mode switched',
        message: 'Switched to monitor',
        severity: 'info',
      })
    }

    const state = useWorkspaceStore.getState()
    expect(state.mode).toBe('monitor')
    expect(state.notifications).toHaveLength(1)
    expect(state.notifications[0].title).toBe('Mode switched')
    expect(state.notifications[0].message).toBe('Switched to monitor')
  })
})
