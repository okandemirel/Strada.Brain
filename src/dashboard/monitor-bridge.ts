import type { WorkspaceBus } from './workspace-bus.js'

export interface MonitorBridge {
  start(): void
  stop(): void
}

export function createMonitorBridge(
  workspaceBus: WorkspaceBus,
  broadcast: (message: string) => void,
): MonitorBridge {
  const listeners: Array<() => void> = []

  return {
    start() {
      // Subscribe to all monitor events and forward to WS clients
      const monitorEvents = [
        'monitor:dag_init',
        'monitor:task_update',
        'monitor:review_result',
        'monitor:agent_activity',
        'monitor:gate_request',
        'monitor:dag_restructure',
      ] as const

      for (const event of monitorEvents) {
        const handler = (payload: unknown) => {
          broadcast(JSON.stringify({ type: event, payload, timestamp: Date.now() }))
        }
        workspaceBus.on(event, handler as any)
        listeners.push(() => workspaceBus.off(event, handler as any))
      }

      // Also forward workspace meta events
      const metaEvents = ['workspace:mode_suggest', 'workspace:notification'] as const
      for (const event of metaEvents) {
        const handler = (payload: unknown) => {
          broadcast(JSON.stringify({ type: event, payload, timestamp: Date.now() }))
        }
        workspaceBus.on(event, handler as any)
        listeners.push(() => workspaceBus.off(event, handler as any))
      }
    },

    stop() {
      for (const unsub of listeners) unsub()
      listeners.length = 0
    },
  }
}
