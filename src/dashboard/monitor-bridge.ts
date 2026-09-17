import { getLoggerSafe } from '../utils/logger.js'
import type { WorkspaceBus } from './workspace-bus.js'

export interface MonitorBridge {
  start(): void
  stop(): void
}

/**
 * Bound on remembered BOARDS (root→origin). Mirrors monitor-lifecycle's
 * MAX_EPISODES: a long-lived process sees many roots and must not accumulate
 * them without limit.
 */
const MAX_TRACKED_ROOTS = 200

/**
 * Bound on remembered node→board pairs, across all boards (round 10 #4).
 *
 * The previous bound was 200 NODES in one flat LRU, which a single DAG exceeds:
 * emit a 201-node board and the first node's ownership was evicted by the last
 * node of its own board, so that node's later `progress:narrative` — the
 * milestone wording derived from the request — became an unattributable frame
 * and was broadcast to every profile. Several smaller live boards did the same.
 *
 * Node ownership is therefore held BY BOARD and evicted BY BOARD: a live board
 * keeps every node it declared, however many, and only the least-recently-used
 * OTHER board is dropped to stay inside the bound. The remaining (extreme) case
 * — one board alone larger than the whole bound — stops remembering rather than
 * forgetting half of itself, and the frames it cannot attribute fail closed.
 */
const MAX_TRACKED_NODES = 10_000

/**
 * The origin of a frame that belongs to no conversation scope: the boards the
 * monitor lifecycle, the supervisor and the CLI emit without one. They are
 * nobody's private traffic, so they stay visible to every portal client — and
 * they are remembered UNDER this marker, so their own rootId-only and
 * nodeId-only incrementals resolve to "global" instead of "unknown" and are not
 * caught by the fail-closed rule below. It cannot collide with a real scope: no
 * conversation id contains a NUL.
 */
const GLOBAL_ORIGIN = '\u0000global'

/**
 * Frames that belong to ONE conversation by construction: a board, its cards and
 * its narratives are all labelled with text derived from that conversation's
 * request. When such a frame names a board (a rootId or a nodeId) that no
 * declaration ever attributed, it is WITHHELD rather than broadcast (round 10
 * #4) — the alternative is handing one profile's request wording to every other
 * one. A frame that names no board at all is not attributable to any
 * conversation and still goes to everybody, as do the canvas/code/workspace/
 * supervisor/budget frames, which are not in this set.
 */
const CONVERSATION_SCOPED_EVENTS: ReadonlySet<string> = new Set([
  'monitor:dag_init',
  'monitor:dag_restructure',
  'monitor:task_update',
  'monitor:review_result',
  'monitor:agent_activity',
  'monitor:gate_request',
  'monitor:substep',
  'progress:narrative',
])

/** Events that DECLARE a board: they carry its full node list. */
const BOARD_DECLARING_EVENTS: ReadonlySet<string> = new Set([
  'monitor:dag_init',
  'monitor:dag_restructure',
])

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
  // frames inherit it. A frame that names NO board at all is not attributable to
  // any conversation and is stamped with no origin — the transport keeps
  // broadcasting those (the canvas/code/budget/supervisor frames that have no
  // scope of their own), because a filter that dropped them would blank the
  // board. A frame that DOES name a board nobody ever declared is a different
  // case, and since round 10 #4 it fails closed: see CONVERSATION_SCOPED_EVENTS.
  //
  // Round 10 #4: ownership is held per BOARD — a root, its origin and the node
  // ids that belong to it — so a board keeps attribution for every node it
  // declared (a 201-node DAG included) and eviction drops a whole
  // least-recently-used OTHER board instead of the oldest individual nodes.
  interface Board {
    origin: string
    nodes: Set<string>
  }
  /** rootId (or a synthetic key for a scope with no root) → its board. */
  const boards = new Map<string, Board>()
  /** nodeId → the board key that declared it. */
  const nodeBoards = new Map<string, string>()
  let trackedNodes = 0

  /** The board key for frames that name a scope but no root. */
  function scopeKey(origin: string): string {
    return `\u0000scope:${origin}`
  }

  function forgetBoard(key: string): void {
    const board = boards.get(key)
    if (!board) return
    for (const node of board.nodes) {
      if (nodeBoards.get(node) === key) nodeBoards.delete(node)
    }
    trackedNodes -= board.nodes.size
    boards.delete(key)
  }

  /**
   * The board for `key`, created (or re-originated) as needed, and touched so
   * insertion order is recency. Creating one may evict the least-recently-used
   * other board.
   */
  function touchBoard(key: string, origin: string): Board {
    const existing = boards.get(key)
    if (existing) {
      existing.origin = origin
      boards.delete(key)
      boards.set(key, existing)
      return existing
    }
    while (boards.size >= MAX_TRACKED_ROOTS) {
      const oldest = boards.keys().next().value
      if (oldest === undefined) break
      forgetBoard(oldest)
    }
    const board: Board = { origin, nodes: new Set() }
    boards.set(key, board)
    return board
  }

  /**
   * Remember that `nodeId` belongs to `key`'s board. Staying inside the node
   * bound evicts OTHER boards, oldest first — never part of this one, which is
   * the board currently being grown.
   */
  function rememberNode(key: string, board: Board, nodeId: string): void {
    const owner = nodeBoards.get(nodeId)
    if (owner === key) return
    if (owner !== undefined) {
      const previous = boards.get(owner)
      if (previous?.nodes.delete(nodeId)) trackedNodes--
    }
    while (trackedNodes >= MAX_TRACKED_NODES) {
      const oldest = boards.keys().next().value
      if (oldest === undefined || oldest === key) break
      forgetBoard(oldest)
    }
    // One board larger than the whole bound: stop remembering rather than
    // forget the nodes it already has. The frames we then cannot attribute are
    // withheld by the fail-closed rule, not broadcast.
    if (trackedNodes >= MAX_TRACKED_NODES) return
    board.nodes.add(nodeId)
    nodeBoards.set(nodeId, key)
    trackedNodes++
  }

  /** Record everything a frame declares about its board, under `origin`. */
  function learn(payload: unknown, origin: string, rootId: string | undefined, nodeId: string | undefined): void {
    const key = rootId ?? scopeKey(origin)
    const board = touchBoard(key, origin)
    if (nodeId) rememberNode(key, board, nodeId)
    for (const id of readNodeIds(payload)) rememberNode(key, board, id)
  }

  /** What a remembered board says about a frame, or undefined when unknown. */
  function recall(rootId: string | undefined, nodeId: string | undefined): { key: string; board: Board } | undefined {
    const key = rootId ?? (nodeId ? nodeBoards.get(nodeId) : undefined)
    if (key === undefined) return undefined
    const board = boards.get(key)
    if (!board) return undefined
    // Touch: this board is in use, so it is not the one eviction should pick.
    boards.delete(key)
    boards.set(key, board)
    return { key, board }
  }

  /**
   * The origin a frame belongs to: a conversation scope, GLOBAL_ORIGIN for the
   * traffic that belongs to everybody, or undefined when the frame names a board
   * nothing ever declared (which the caller refuses to broadcast for a
   * conversation-scoped event).
   */
  function originOf(event: string, payload: unknown): string | undefined {
    const conversationId = readString(payload, 'conversationId')
    const rootId = readString(payload, 'rootId')
    const nodeId = readString(payload, 'nodeId')
    if (conversationId) {
      learn(payload, conversationId, rootId, nodeId)
      return conversationId
    }
    // A board declaration with no scope of its own (monitor-lifecycle, the
    // supervisor, a CLI run): it is everybody's, and saying so here is what
    // keeps its own later incrementals out of the fail-closed branch.
    if (BOARD_DECLARING_EVENTS.has(event) && rootId) {
      const known = boards.get(rootId)
      const origin = known?.origin ?? GLOBAL_ORIGIN
      learn(payload, origin, rootId, nodeId)
      return origin
    }
    const remembered = recall(rootId, nodeId)
    if (remembered) {
      // An incremental still teaches us about the nodes it names.
      if (nodeId) rememberNode(remembered.key, remembered.board, nodeId)
      for (const id of readNodeIds(payload)) rememberNode(remembered.key, remembered.board, id)
      return remembered.board.origin
    }
    // Names a board we do not know: unknown. Names nothing at all: global.
    return rootId || nodeId ? undefined : GLOBAL_ORIGIN
  }

  function forgetEverything(): void {
    boards.clear()
    nodeBoards.clear()
    trackedNodes = 0
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
            forgetEverything()
          }
          const origin = originOf(event, payload)
          if (origin === undefined && CONVERSATION_SCOPED_EVENTS.has(event)) {
            // Fail closed (round 10 #4): this frame belongs to ONE conversation
            // and we cannot say which, so it goes to nobody rather than to
            // everybody. Logged, because a frame that disappears must be
            // explainable.
            getLoggerSafe().debug('monitor frame withheld: no attributable origin', {
              event,
              rootId: readString(payload, 'rootId'),
              nodeId: readString(payload, 'nodeId'),
            })
            return
          }
          broadcast(
            JSON.stringify({
              type: event,
              payload,
              ...(origin && origin !== GLOBAL_ORIGIN ? { origin } : {}),
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
      forgetEverything()
    },
  }
}
