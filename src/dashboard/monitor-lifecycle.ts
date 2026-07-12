/**
 * Monitor Lifecycle Manager
 *
 * Ensures the web portal monitor workspace (DAG + Kanban) always reflects
 * the current agent activity, organized into EPISODES. An EPISODE is one
 * persistent workspace (a single DAG/Kanban board) for one logical task. It
 * persists across the requests that belong to it and only rolls over to a fresh
 * board once the active task goes terminal.
 *
 * Episode model:
 *   - One episode == one monitor root (`rootId === episodeId`). Where the prior
 *     model minted a fresh `req-<uuid>` root per REQUEST, the episode model mints
 *     an `ep-<uuid>` per EPISODE and reuses it for follow-up requests that arrive
 *     while the active task is still in-progress (they JOIN/UPDATE the same board).
 *   - A request that arrives when there is no episode, or after the active episode
 *     went terminal, mints a NEW episode (a fresh workspace).
 *   - The conversationId (chat-level grouping) is unchanged — episodes still group
 *     under their conversation in the RootSwitcher; prior episodes stay reachable.
 *   - Episode boundaries touch ONLY the monitor dag rootId. They never enter
 *     identity/session/memory keying (those stay on user/chat) — SAFE by design.
 *
 * Whole-goal monitor unit (workers/sub-goals roll up to the PARENT episode):
 *   Every lifecycle method takes an OPTIONAL `monitorScope` that, when present,
 *   overrides the request's own `conversationScope` as BOTH the episode-map key
 *   AND the emitted `conversationId`. A worker / spawned-agent / per-sub-goal run
 *   that presents the PARENT goal's monitorScope therefore JOINs the parent's open
 *   episode (resolveEpisode finds it instead of minting a fresh `ep-…`) and emits
 *   under the parent `conversationId` (the frontend RootSwitcher groups it into the
 *   parent conversation — NOT a new conversation/episode). Absent ⇒ byte-identical
 *   to the prior per-scope behavior. The override is MONITOR-only: it never touches
 *   the worker's fresh AGENT chatId/session/identity (those stay fresh by design).
 *
 * Lifecycle:
 *   requestStart  → resolve/mint episode; emit a single-node DAG for the request
 *                   (a NEW episode opens the board; a CONTINUE adds a card to it)
 *   joinEpisode   → like requestStart but NEVER mints a fresh episode: a worker/
 *                   sub-goal run adds its card ONLY when a parent episode is already
 *                   open under the monitorScope (no-op otherwise). Used by re-scoped
 *                   worker runs so they roll up without opening a sibling workspace.
 *   goalDecomposed → multi-node goal tree replaces the simple node, emitted under
 *                    the SAME episodeId so decomposition grows THIS board (never a
 *                    sibling root)
 *   requestEnd     → simple node settled to completed/failed; episode marked
 *                    terminal (kept, not deleted) so the next request rolls over.
 *                    ONLY the whole-goal root run calls this — a re-scoped worker
 *                    run must use `joinEpisodeEnd` so it settles its OWN card
 *                    without prematurely terminating the shared parent episode.
 *   joinEpisodeEnd → settle a joined worker card (LIFO) WITHOUT marking the parent
 *                    episode terminal — the episode lives until the root requestEnd.
 */

import type { WorkspaceBus } from './workspace-bus.js'
// getLoggerSafe: no-op before createLogger() runs (e.g. unit tests) — a monitor
// lifecycle event must never throw for want of the logging singleton.
import { getLoggerSafe } from '../utils/logger.js'
import type { GoalTree } from '../goals/types.js'
import { goalTreeToDagPayload, type DagNodeShape, type DagPayload } from './workspace-events.js'

export interface MonitorLifecycle {
  /**
   * Resolve/mint the episode for this scope and emit a single-node DAG for the
   * request. `monitorScope`, when provided, overrides `conversationScope` as the
   * episode key + emitted conversationId so a re-scoped run rolls up to the parent
   * goal's episode (whole-goal unit) rather than opening a new conversation.
   */
  requestStart(conversationScope: string, userMessage: string, monitorScope?: string): void
  /**
   * Add a worker/sub-goal card to an ALREADY-OPEN parent episode (keyed by
   * `monitorScope`, falling back to `conversationScope`). Unlike requestStart this
   * NEVER mints a fresh episode — if no parent episode is open it is a no-op (the
   * worker simply stays monitor-silent rather than spraying a sibling workspace).
   */
  joinEpisode(conversationScope: string, userMessage: string, monitorScope?: string): void
  /** Replace the simple node with a decomposed goal tree, under the active episode root. */
  goalDecomposed(conversationScope: string, goalTree: GoalTree, monitorScope?: string): void
  /** Emit DAG restructure for the active episode's goal tree. */
  goalRestructured(conversationScope: string, goalTree: GoalTree, monitorScope?: string): void
  /** Settle the simple task (completed/failed) and mark the episode terminal. */
  requestEnd(conversationScope: string, failed?: boolean, monitorScope?: string): void
  /**
   * Settle a joined worker/sub-goal card (LIFO) WITHOUT marking the parent episode
   * terminal. The whole-goal episode stays open until the ROOT run's requestEnd, so
   * a finishing worker never rolls the dropdown over early.
   */
  joinEpisodeEnd(conversationScope: string, failed?: boolean, monitorScope?: string): void
  /**
   * BUG#1 P2 — live plan-step DAG for a PLAIN interactive/background loop (no supervisor,
   * no goal-tree decomposition). Each PAOR tool batch calls this with its monotonic
   * `batchIndex` (0-based, the SINGLE source for node ids: `step-<batchIndex>`) so the one
   * static "executing" card grows into a live multi-node DAG that advances as batches run.
   *
   * Behaviour, under the ACTIVE episode root (looked up by scope — never mints one; a no-op
   * if none is open or it is terminal, exactly like joinEpisode/goalDecomposed):
   *   - batchIndex 0: settle the simple `req-…` card (completed — it is SUPERSEDED, like
   *     goalDecomposed) then seed a `dag_init` with `step-0` (executing).
   *   - batchIndex n>0: mark `step-<n-1>` completed and re-emit `dag_init` with all
   *     accumulated nodes (prior=completed, new=executing) so the board grows in place.
   * The final in-flight step node is settled by requestEnd/joinEpisodeEnd.
   *
   * Two-stage suppression keeps this off supervisor/decomposed boards: the ENGINE gate
   * (tool-turn.ts isPlainLoop) excludes supervisor sub-node + parent-rollup workers, and
   * THIS method no-ops when the episode board was re-rooted as a goal tree (dagKind !=
   * 'simple', set by goalDecomposed/goalRestructured). The latter is the authoritative
   * decomposition check — timing-correct because goalDecomposed fires in PLANNING, before
   * the first tool turn reaches stepBatch.
   */
  stepBatch(conversationScope: string, batchIndex: number, toolLabel: string, monitorScope?: string): void
}

import { randomUUID } from "node:crypto";

const MAX_TASK_LABEL = 200

// Bound the per-scope episode map so a long-lived process with many distinct
// conversation scopes can never accumulate episode entries without limit.
// Mirrors the MAX_SESSIONS / MAX_QUEUE_NOTICE_COOLDOWNS oldest-drop idiom.
const MAX_EPISODES = 200

interface EpisodeState {
  /** The active episode's monitor root id (`ep-<uuid>`). */
  episodeId: string
  /**
   * In-flight simple single-node DAG cards for THIS episode, in start order.
   * Each request within an episode pushes its own card so a follow-up shows as
   * its own Kanban item rather than mutating the prior request's card. A card is
   * popped when its request settles (requestEnd) or is superseded by goal
   * decomposition.
   *
   * This is a LIST, not a single slot, so concurrent same-scope requests (e.g. an
   * interactive chat message and a background task on the same conversationScope —
   * serialized by independent locks, so they CAN overlap) each retain their own
   * card. With a single slot the second start would overwrite the first's id and
   * the first card would never receive its terminal task_update (lingering
   * "executing"); the list lets each settle pop its own most-recent card (LIFO).
   */
  simpleNodeIds: string[]
  /**
   * True once the active task went terminal. The episode entry is kept (not
   * deleted) so a same-tick re-entrant requestStart still observes `terminal`
   * and rolls over to a fresh episode rather than missing the boundary.
   */
  terminal: boolean
  /**
   * BUG#1 P2 — what OWNS this episode's board. `'simple'` (the default) means the
   * board is the requestStart single card / plain-loop step DAG, which the plain
   * loop may drive. `'goal-tree'` means goalDecomposed/goalRestructured re-rooted the
   * board as a REAL decomposed goal tree whose node status flows via goal:status-changed;
   * the plain-loop step DAG must then stay silent (stepBatch no-ops) so it never
   * double-drives / collides with the goal-tree node-id stream.
   *
   * This is the AUTHORITATIVE decomposition/supervisor-board signal (the engine's
   * runCtx.goalsDecomposed is NOT — it flips true in PLANNING for every run, before
   * any tree is known). It is set by the actual goalDecomposed call, which fires ONLY
   * when a real tree is produced (runProactiveGoalDecomposition returns early otherwise).
   */
  dagKind: 'simple' | 'goal-tree'
  /**
   * BUG#1 P2 — the live plain-loop step DAG for THIS episode. Undefined until the
   * first `stepBatch` seeds it (a plain interactive/background loop's first tool batch).
   * `nodes` is the accumulated `step-<i>` node list re-emitted on each grow so the board
   * grows in place; `activeStepNodeId` is the in-flight (executing) node settled by
   * requestEnd/joinEpisodeEnd. Supervisor/decomposed runs never populate this (they own
   * the board via their own node-id streams and never call stepBatch).
   */
  stepDag?: {
    nodes: DagNodeShape[]
    activeStepNodeId: string | undefined
  }
}

function generateEpisodeId(): string {
  return `ep-${randomUUID()}`
}

function generateNodeId(): string {
  return `req-${randomUUID()}`
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

export function createMonitorLifecycle(workspaceBus: WorkspaceBus): MonitorLifecycle {
  // Per-conversation-scope episode state. One entry per scope; rolled over (same
  // key, fresh episodeId) when the active task is terminal and a new request arrives.
  const episodes = new Map<string, EpisodeState>()

  /** Bound the episode map by dropping the oldest entry when at capacity. */
  function pruneEpisodes(): void {
    while (episodes.size >= MAX_EPISODES) {
      const oldestKey = episodes.keys().next().value
      if (oldestKey === undefined) break
      episodes.delete(oldestKey)
    }
  }

  /**
   * Pick the effective episode key + emitted conversationId. `monitorScope` (the
   * whole-goal scope) wins when present and non-empty so a worker/sub-goal run
   * rolls its card up to the PARENT episode (one workspace per whole goal). Absent
   * ⇒ the request's own conversationScope (byte-identical to the prior behavior).
   */
  function resolveScopeKey(conversationScope: string, monitorScope?: string): string {
    const trimmed = monitorScope?.trim()
    return trimmed ? trimmed : conversationScope
  }

  /**
   * Resolve the active episode for a scope, minting a fresh one when none exists
   * or the prior episode is terminal. Re-inserts on mint so the bounded map's
   * insertion-order eviction favors the least-recently-started scopes.
   */
  function resolveEpisode(scopeKey: string): EpisodeState {
    const existing = episodes.get(scopeKey)
    if (existing && !existing.terminal) {
      return existing
    }
    // Drop the stale terminal entry so the re-insert refreshes insertion order.
    if (existing) episodes.delete(scopeKey)
    pruneEpisodes()
    const fresh: EpisodeState = { episodeId: generateEpisodeId(), simpleNodeIds: [], terminal: false, dagKind: 'simple' }
    episodes.set(scopeKey, fresh)
    return fresh
  }

  /**
   * Apply the active episode's id as the rootId override on a goal-tree payload so
   * decomposition/restructure grows THIS episode board rather than spraying a
   * sibling root keyed by the goal tree's own id. Per-node task_update events that
   * later carry the goalTree.rootId still land correctly: the frontend resolves a
   * node to its owning bucket by node id, independent of the update's rootId.
   */
  function withEpisodeRoot(payload: DagPayload, episode: EpisodeState | undefined): DagPayload {
    return { ...payload, rootId: episode?.episodeId ?? payload.rootId }
  }

  /**
   * Emit a fresh single-node DAG card under an episode. Shared by requestStart
   * (which mints/continues the episode) and joinEpisode (which only adds a card to
   * an already-open parent episode). `emittedScope` is the conversationId carried
   * on the payload — the whole-goal monitorScope when re-scoped, else the request's
   * own scope — so the frontend RootSwitcher groups the card under the right
   * conversation.
   */
  function emitStartCard(episode: EpisodeState, userMessage: string, emittedScope: string): void {
    const nodeId = generateNodeId()
    episode.simpleNodeIds.push(nodeId)

    const node: DagNodeShape = {
      id: nodeId,
      task: truncate(userMessage, MAX_TASK_LABEL),
      status: 'executing',
      reviewStatus: 'none',
      depth: 1,
      dependsOn: [],
    }

    // dag_init carries the episodeId as rootId. A NEW episode opens a fresh
    // board (frontend transitions the active view); a CONTINUE re-emits the
    // SAME episodeId, so the frontend merges the new card into the existing
    // board in place (no transition flash, no sibling root).
    workspaceBus.emit('monitor:dag_init', {
      rootId: episode.episodeId,
      nodes: [node],
      edges: [],
      conversationId: emittedScope,
    })
  }

  /** Settle the most-recent in-flight card (LIFO) of an episode to a terminal state. */
  function settleLatestCard(episode: EpisodeState, emittedScope: string, failed: boolean): void {
    const nodeId = episode.simpleNodeIds.pop()
    if (!nodeId) return
    workspaceBus.emit('monitor:task_update', {
      rootId: episode.episodeId,
      nodeId,
      status: failed ? 'failed' : 'completed',
      conversationId: emittedScope,
    })
  }

  /**
   * Update a plain-loop step node's status IN MEMORY only (no WS emit). Used mid-batch:
   * stepBatch marks the prior node 'completed' here, then re-emits the FULL dag_init, whose
   * node list carries this updated status — so a separate task_update would be redundant
   * (frontend setDAG REPLACES the root topology). Single source = the dag_init re-emit.
   */
  function setStepStatusInMemory(
    episode: EpisodeState,
    nodeId: string,
    status: 'executing' | 'completed' | 'failed',
  ): void {
    const dag = episode.stepDag
    if (!dag) return
    const idx = dag.nodes.findIndex((n) => n.id === nodeId)
    if (idx >= 0) dag.nodes[idx] = { ...dag.nodes[idx]!, status }
  }

  /**
   * Settle the in-flight step-DAG node (if any) to a terminal state, on episode end.
   * Idempotent: clears activeStepNodeId so a second end call is a no-op. Unlike the mid-batch
   * path there is NO following dag_init here (the run is ending), so this DOES emit a
   * task_update — the only way the final node reaches a terminal state on the board.
   */
  function settleActiveStepNode(episode: EpisodeState, emittedScope: string, failed: boolean): void {
    const nodeId = episode.stepDag?.activeStepNodeId
    if (!nodeId) return
    episode.stepDag!.activeStepNodeId = undefined
    const status = failed ? 'failed' : 'completed'
    setStepStatusInMemory(episode, nodeId, status)
    workspaceBus.emit('monitor:task_update', {
      rootId: episode.episodeId,
      nodeId,
      status,
      phase: 'observing',
      completedAt: Date.now(),
      conversationId: emittedScope,
    })
  }

  const lifecycle: MonitorLifecycle = {
    requestStart(conversationScope: string, userMessage: string, monitorScope?: string): void {
      const scopeKey = resolveScopeKey(conversationScope, monitorScope)
      // Capture the prior entry BEFORE resolveEpisode so the log line can attribute
      // every episode boundary: a MINT (no prior / rollover after terminal) vs a
      // CONTINUE (card added to the open episode). Monitor events are otherwise
      // WS-only — this is the file-log trail that lets a soak verify "one
      // conversation per whole goal" (and, if a spray ever reappears, its source).
      const prior = episodes.get(scopeKey)
      const episode = resolveEpisode(scopeKey)
      getLoggerSafe().info('Monitor episode request-start', {
        scopeKey,
        episodeId: episode.episodeId,
        minted: !prior || prior.terminal,
        ...(prior?.terminal ? { rolledOverFrom: prior.episodeId } : {}),
      })
      // Each request gets its own simple node (Kanban card) inside the episode.
      emitStartCard(episode, userMessage, scopeKey)
    },

    joinEpisode(conversationScope: string, userMessage: string, monitorScope?: string): void {
      // Worker/sub-goal rollup: add a card ONLY when a parent episode is already
      // open under the (monitor)scope. Never mints a fresh episode — if none is
      // open the worker stays monitor-silent rather than spraying a sibling
      // workspace (the whole-goal root owns episode creation).
      const scopeKey = resolveScopeKey(conversationScope, monitorScope)
      const episode = episodes.get(scopeKey)
      getLoggerSafe().info('Monitor episode join', {
        scopeKey,
        episodeId: episode?.episodeId,
        joined: Boolean(episode && !episode.terminal),
      })
      if (!episode || episode.terminal) return
      emitStartCard(episode, userMessage, scopeKey)
    },

    goalDecomposed(conversationScope: string, goalTree: GoalTree, monitorScope?: string): void {
      // Goal decomposition replaces the simple task with the real goal tree.
      // Settle the most-recent in-flight simple node to a terminal Kanban state
      // first (LIFO — it is the card being decomposed) so the superseded `req-…`
      // card doesn't linger "executing" (it is being replaced by a richer
      // representation, not failed). Then emit the decomposed tree UNDER THE
      // EPISODE ROOT (not the goal tree's own rootId) so decomposition grows THIS
      // board rather than spraying a sibling root.
      const scopeKey = resolveScopeKey(conversationScope, monitorScope)
      const episode = episodes.get(scopeKey)
      if (episode) {
        settleLatestCard(episode, scopeKey, false)
        // BUG#1 P2: the board is now a REAL decomposed goal tree — mark it so the plain-loop
        // step DAG (stepBatch) stays silent and never double-drives the goal-tree node ids.
        episode.dagKind = 'goal-tree'
      }
      const payload = goalTreeToDagPayload(goalTree, scopeKey)
      getLoggerSafe().info('Monitor episode goal-decomposed', {
        scopeKey,
        episodeId: episode?.episodeId,
        goalRootId: payload.rootId,
        nodeCount: payload.nodes.length,
      })
      workspaceBus.emit('monitor:dag_init', withEpisodeRoot(payload, episode))
    },

    goalRestructured(conversationScope: string, goalTree: GoalTree, monitorScope?: string): void {
      // Restructure lands on the SAME episode board (rootId overridden to the
      // episodeId) so a reactive re-plan updates this workspace in place.
      const scopeKey = resolveScopeKey(conversationScope, monitorScope)
      const episode = episodes.get(scopeKey)
      // BUG#1 P2: a reactive re-plan also makes the board a goal tree — suppress the plain-loop DAG.
      if (episode) episode.dagKind = 'goal-tree'
      const payload = goalTreeToDagPayload(goalTree, scopeKey)
      workspaceBus.emit('monitor:dag_restructure', withEpisodeRoot(payload, episode))
    },

    requestEnd(conversationScope: string, failed = false, monitorScope?: string): void {
      const scopeKey = resolveScopeKey(conversationScope, monitorScope)
      const episode = episodes.get(scopeKey)
      if (!episode) {
        // A requestEnd with no episode may indicate a scope-key mismatch — worth a trace.
        getLoggerSafe().debug('Monitor episode request-end without an active episode', { scopeKey })
        return
      }
      getLoggerSafe().info('Monitor episode terminal', {
        scopeKey,
        episodeId: episode.episodeId,
        failed,
      })
      // Settle this request's simple node (the most-recent in-flight card, LIFO),
      // if any remains un-superseded by decomposition. Tracking each request's
      // card separately means a concurrent same-scope request (e.g. interactive +
      // background) still has its OWN card settled rather than one card lingering
      // "executing" because a single shared slot was overwritten.
      settleLatestCard(episode, scopeKey, failed)
      // BUG#1 P2: settle a plain-loop step DAG's last in-flight node too (its simple
      // card was already superseded on the first batch, so settleLatestCard is a no-op).
      settleActiveStepNode(episode, scopeKey, failed)
      // Mark the episode terminal (keep the entry) so the next request rolls over
      // to a fresh episode/workspace even if it arrives on the same tick.
      episode.terminal = true
    },

    joinEpisodeEnd(conversationScope: string, failed = false, monitorScope?: string): void {
      // Settle a joined worker/sub-goal card WITHOUT marking the parent episode
      // terminal — the whole-goal episode must stay open until the ROOT run's
      // requestEnd, so a finishing worker never rolls the dropdown over early.
      const scopeKey = resolveScopeKey(conversationScope, monitorScope)
      const episode = episodes.get(scopeKey)
      if (!episode) return
      getLoggerSafe().debug('Monitor episode joined-card settled', {
        scopeKey,
        episodeId: episode.episodeId,
        failed,
      })
      settleLatestCard(episode, scopeKey, failed)
      settleActiveStepNode(episode, scopeKey, failed)
    },

    stepBatch(conversationScope: string, batchIndex: number, toolLabel: string, monitorScope?: string): void {
      // BUG#1 P2 — plain interactive/background loop only (the engine's suppression guard
      // proves it: no supervisor, no goal-tree/decomposition owns this board). Grow the one
      // static "executing" card into a live step DAG under the ACTIVE episode root. Never
      // mints an episode: if none is open (or terminal) this is a no-op, matching joinEpisode.
      const scopeKey = resolveScopeKey(conversationScope, monitorScope)
      const episode = episodes.get(scopeKey)
      if (!episode || episode.terminal) return
      // AUTHORITATIVE decomposition/supervisor guard: once the board is a real goal tree
      // (goalDecomposed/goalRestructured re-rooted it), the plain-loop step DAG must stay
      // silent — its status stream is goal:status-changed, and driving step nodes here would
      // collide with the goal-tree node ids. This is timing-correct: goalDecomposed runs in
      // PLANNING, BEFORE any tool turn calls stepBatch, so dagKind is already 'goal-tree' by then.
      if (episode.dagKind !== 'simple') {
        getLoggerSafe().debug('Monitor plain-loop step suppressed (goal-tree board)', {
          scopeKey,
          episodeId: episode.episodeId,
        })
        return
      }
      const nodeId = `step-${batchIndex}`

      if (!episode.stepDag) {
        // First batch: supersede the simple `req-…` card (completed, not failed — it is
        // being replaced by a richer live view, exactly as goalDecomposed does), then seed
        // the step DAG. If batchIndex is not 0 (a defensive out-of-order first call) we still
        // seed from THIS node so the board never desyncs.
        settleLatestCard(episode, scopeKey, false)
        const node: DagNodeShape = {
          id: nodeId,
          task: truncate(toolLabel, MAX_TASK_LABEL),
          status: 'executing',
          reviewStatus: 'none',
          depth: 1,
          dependsOn: [],
        }
        episode.stepDag = { nodes: [node], activeStepNodeId: nodeId }
      } else {
        // Subsequent batch: mark the prior in-flight node completed IN MEMORY (the dag_init
        // re-emit below carries the updated status — no redundant per-batch task_update), then
        // append this one.
        const prior = episode.stepDag.activeStepNodeId
        if (prior && prior !== nodeId) {
          setStepStatusInMemory(episode, prior, 'completed')
        }
        // Guard against a duplicate index (e.g. a retry): only append a genuinely new node.
        if (!episode.stepDag.nodes.some((n) => n.id === nodeId)) {
          const prevId = episode.stepDag.nodes[episode.stepDag.nodes.length - 1]?.id
          episode.stepDag.nodes.push({
            id: nodeId,
            task: truncate(toolLabel, MAX_TASK_LABEL),
            status: 'executing',
            reviewStatus: 'none',
            depth: 1,
            dependsOn: prevId ? [prevId] : [],
          })
        }
        episode.stepDag.activeStepNodeId = nodeId
      }

      getLoggerSafe().debug('Monitor plain-loop step batch', {
        scopeKey,
        episodeId: episode.episodeId,
        nodeId,
        stepCount: episode.stepDag.nodes.length,
      })

      // Re-emit dag_init with ALL accumulated nodes (each carrying its latest status) under
      // the episode root. setDAG REPLACES this root's topology, so the full list is required;
      // the edges chain step→step so the DAG renders as a linear plan. Node ids are the SINGLE
      // source (`step-<batchIndex>`) shared with the task_update stream above — no drift.
      const edges: Array<{ source: string; target: string }> = []
      for (const n of episode.stepDag.nodes) {
        for (const dep of n.dependsOn) edges.push({ source: dep, target: n.id })
      }
      workspaceBus.emit('monitor:dag_init', {
        rootId: episode.episodeId,
        nodes: episode.stepDag.nodes.map((n) => ({ ...n })),
        edges,
        conversationId: scopeKey,
      })
    },
  }

  return lifecycle
}
