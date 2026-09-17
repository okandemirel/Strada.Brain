import type { WorkspaceBus } from './workspace-bus.js'

export interface MonitorBridge {
  start(): void
  stop(): void
}

/**
 * Bound on remembered root→origin pairs. Mirrors monitor-lifecycle's MAX_EPISODES:
 * a long-lived process sees many roots and must not accumulate them without limit.
 */
const MAX_TRACKED_ROOTS = 200

/** Read a string property off an untyped event payload. */
function readString(payload: unknown, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function createMonitorBridge(
  workspaceBus: WorkspaceBus,
  broadcast: (message: string) => void,
): MonitorBridge {
  const listeners: Array<() => void> = []

  // ── Audit 13F5 / plan 4.7: every monitor frame carries its ORIGIN ──
  //
  // The workspace bus is process-wide and this bridge fans every frame out to
  // every connected client, so a frame belonging to one portal profile reached
  // the others — including the request text a DAG card is labelled with. The
  // frame's origin is the conversation scope it was emitted under (for the web
  // channel that scope IS the profileId; for other channels it is that
  // channel's conversation id), and the transport filters on it.
  //
  // Most frames name their scope as `payload.conversationId`, but the
  // incrementals that grow a board (monitor:substep, a fallback task_update)
  // carry only `payload.rootId`. A root is owned by exactly one scope, so the
  // first frame that names both teaches us the pairing and the later rootId-only
  // frames inherit it. A frame with neither is not attributable and is stamped
  // with no origin at all — the transport must keep broadcasting those (the
  // canvas/code/budget/supervisor frames that have no scope of their own),
  // because a filter that drops what it cannot attribute would blank the board.
  const rootOrigins = new Map<string, string>()

  function rememberRoot(rootId: string, origin: string): void {
    // Re-insert so the bounded map's insertion-order eviction drops the
    // least-recently-touched root, not the busiest one.
    rootOrigins.delete(rootId)
    while (rootOrigins.size >= MAX_TRACKED_ROOTS) {
      const oldest = rootOrigins.keys().next().value
      if (oldest === undefined) break
      rootOrigins.delete(oldest)
    }
    rootOrigins.set(rootId, origin)
  }

  /** The origin a frame belongs to, or undefined when it is not attributable. */
  function originOf(payload: unknown): string | undefined {
    const conversationId = readString(payload, 'conversationId')
    const rootId = readString(payload, 'rootId')
    if (conversationId) {
      if (rootId) rememberRoot(rootId, conversationId)
      return conversationId
    }
    if (rootId) {
      const known = rootOrigins.get(rootId)
      if (known) {
        rootOrigins.delete(rootId)
        rootOrigins.set(rootId, known)
      }
      return known
    }
    return undefined
  }

  return {
    start() {
      // All workspace events forwarded to connected WS clients
      const FORWARDED_EVENTS = [
        'monitor:clear',
        'monitor:dag_init',
        'monitor:task_update',
        'monitor:review_result',
        'monitor:agent_activity',
        'monitor:gate_request',
        'monitor:dag_restructure',
        'monitor:substep',
        'progress:narrative',
        'canvas:agent_draw',
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
        'supervisor:activated',
        'supervisor:plan_ready',
        'supervisor:wave_start',
        'supervisor:node_start',
        'supervisor:node_complete',
        'supervisor:node_failed',
        'supervisor:escalation',
        'supervisor:wave_done',
        'supervisor:verify_start',
        'supervisor:verify_done',
        'supervisor:complete',
        'supervisor:aborted',
        'budget:warning',
        'budget:exceeded',
      ] as const

      for (const event of FORWARDED_EVENTS) {
        const handler = (payload: unknown) => {
          if (event === 'monitor:clear') {
            // The boards are gone; so are the root→origin pairings.
            rootOrigins.clear()
          }
          const origin = originOf(payload)
          broadcast(
            JSON.stringify({
              type: event,
              payload,
              ...(origin ? { origin } : {}),
              timestamp: Date.now(),
            }),
          )
        }
        // WorkspaceBus index signature allows any string key → unknown payload
        workspaceBus.on(event, handler)
        listeners.push(() => workspaceBus.off(event, handler))
      }
    },

    stop() {
      for (const unsub of listeners) unsub()
      listeners.length = 0
      rootOrigins.clear()
    },
  }
}
