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

/**
 * The node ids a DAG payload declares. Accepts `nodes` at the top level (what
 * monitor-lifecycle and goalTreeToDagPayload emit) and `dag.nodes` (the shape
 * the portal's message types describe), so neither spelling silently contributes
 * nothing.
 */
function readNodeIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return []
  const bag = payload as Record<string, unknown>
  const lists: unknown[] = [bag['nodes']]
  const dag = bag['dag']
  if (typeof dag === 'object' && dag !== null) lists.push((dag as Record<string, unknown>)['nodes'])
  const ids: string[] = []
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const node of list) {
      const id = readString(node, 'id')
      if (id) ids.push(id)
    }
  }
  return ids
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
  // …and the same for NODE ids, because some frames name neither a conversation
  // nor a root: `progress:narrative` carries only `nodeId` and its text is the
  // milestone wording derived from the request, which is exactly what must not
  // cross profiles. A node belongs to one board, which belongs to one scope, so
  // the DAG frame that declares the node teaches the pairing.
  const nodeOrigins = new Map<string, string>()

  /** Insert into a bounded map, dropping the least-recently-touched entry. */
  function remember(map: Map<string, string>, key: string, origin: string): void {
    // Re-insert so the insertion-order eviction drops the least-recently-touched
    // entry, not the busiest one.
    map.delete(key)
    while (map.size >= MAX_TRACKED_ROOTS) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
    map.set(key, origin)
  }

  /** Read a remembered origin, refreshing its recency. */
  function recall(map: Map<string, string>, key: string): string | undefined {
    const known = map.get(key)
    if (known !== undefined) {
      map.delete(key)
      map.set(key, known)
    }
    return known
  }

  /** The origin a frame belongs to, or undefined when it is not attributable. */
  function originOf(payload: unknown): string | undefined {
    const conversationId = readString(payload, 'conversationId')
    const rootId = readString(payload, 'rootId')
    const nodeId = readString(payload, 'nodeId')
    if (conversationId) {
      if (rootId) remember(rootOrigins, rootId, conversationId)
      if (nodeId) remember(nodeOrigins, nodeId, conversationId)
      for (const id of readNodeIds(payload)) remember(nodeOrigins, id, conversationId)
      return conversationId
    }
    if (rootId) {
      const known = recall(rootOrigins, rootId)
      if (known !== undefined) {
        // A rootId-only frame still teaches us about the nodes it names.
        if (nodeId) remember(nodeOrigins, nodeId, known)
        for (const id of readNodeIds(payload)) remember(nodeOrigins, id, known)
        return known
      }
    }
    if (nodeId) return recall(nodeOrigins, nodeId)
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
            // The boards are gone; so are the root/node→origin pairings.
            rootOrigins.clear()
            nodeOrigins.clear()
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
      nodeOrigins.clear()
    },
  }
}
