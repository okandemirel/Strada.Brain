/**
 * Registers all sibling Zustand store resets as logout hooks.
 * Import this module once at app startup (e.g. from WebSocketProvider or App.tsx)
 * so that useSessionStore.getState().logout() cascades to all stores.
 */
import { onLogout } from './session-store'
import { useWorkspaceStore } from './workspace-store'
import { useCanvasStore } from './canvas-store'
import { useCodeStore } from './code-store'
import { useMonitorStore } from './monitor-store'
import { useSupervisorStore } from './supervisor-store'

onLogout(() => useWorkspaceStore.getState().reset())
onLogout(() => useCanvasStore.getState().reset())
onLogout(() => useCodeStore.getState().reset())
onLogout(() => useMonitorStore.getState().clearMonitor())
onLogout(() => useSupervisorStore.getState().clear())
