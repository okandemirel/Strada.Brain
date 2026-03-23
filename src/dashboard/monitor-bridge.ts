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
      // All workspace events forwarded to connected WS clients
      const FORWARDED_EVENTS = [
        'monitor:dag_init',
        'monitor:task_update',
        'monitor:review_result',
        'monitor:agent_activity',
        'monitor:gate_request',
        'monitor:dag_restructure',
        'canvas:shapes_add',
        'canvas:shapes_update',
        'canvas:shapes_remove',
        'canvas:viewport',
        'canvas:arrange',
        'code:file_open',
        'code:file_update',
        'code:terminal_output',
        'code:terminal_clear',
        'code:annotation_add',
        'code:annotation_clear',
        'workspace:mode_suggest',
        'workspace:notification',
      ] as const

      for (const event of FORWARDED_EVENTS) {
        const handler = (payload: unknown) => {
          broadcast(JSON.stringify({ type: event, payload, timestamp: Date.now() }))
        }
        // WorkspaceBus index signature allows any string key → unknown payload
        workspaceBus.on(event, handler)
        listeners.push(() => workspaceBus.off(event, handler))
      }
    },

    stop() {
      for (const unsub of listeners) unsub()
      listeners.length = 0
    },
  }
}
