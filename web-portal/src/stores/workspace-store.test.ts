import { describe, expect, it, beforeEach } from 'vitest'
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
