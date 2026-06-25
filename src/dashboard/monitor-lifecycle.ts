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
 * Lifecycle:
 *   requestStart  → resolve/mint episode; emit a single-node DAG for the request
 *                   (a NEW episode opens the board; a CONTINUE adds a card to it)
 *   goalDecomposed → multi-node goal tree replaces the simple node, emitted under
 *                    the SAME episodeId so decomposition grows THIS board (never a
 *                    sibling root)
 *   requestEnd     → simple node settled to completed/failed; episode marked
 *                    terminal (kept, not deleted) so the next request rolls over
 */

import type { WorkspaceBus } from './workspace-bus.js'
import type { GoalTree } from '../goals/types.js'
import { goalTreeToDagPayload, type DagNodeShape, type DagPayload } from './workspace-events.js'

export interface MonitorLifecycle {
  /** Resolve/mint the episode for this scope and emit a single-node DAG for the request. */
  requestStart(conversationScope: string, userMessage: string): void
  /** Replace the simple node with a decomposed goal tree, under the active episode root. */
  goalDecomposed(conversationScope: string, goalTree: GoalTree): void
  /** Emit DAG restructure for the active episode's goal tree. */
  goalRestructured(conversationScope: string, goalTree: GoalTree): void
  /** Settle the simple task (completed/failed) and mark the episode terminal. */
  requestEnd(conversationScope: string, failed?: boolean): void
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
   * Resolve the active episode for a scope, minting a fresh one when none exists
   * or the prior episode is terminal. Re-inserts on mint so the bounded map's
   * insertion-order eviction favors the least-recently-started scopes.
   */
  function resolveEpisode(conversationScope: string): EpisodeState {
    const existing = episodes.get(conversationScope)
    if (existing && !existing.terminal) {
      return existing
    }
    // Drop the stale terminal entry so the re-insert refreshes insertion order.
    if (existing) episodes.delete(conversationScope)
    pruneEpisodes()
    const fresh: EpisodeState = { episodeId: generateEpisodeId(), simpleNodeIds: [], terminal: false }
    episodes.set(conversationScope, fresh)
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

  const lifecycle: MonitorLifecycle = {
    requestStart(conversationScope: string, userMessage: string): void {
      const episode = resolveEpisode(conversationScope)
      // Each request gets its own simple node (Kanban card) inside the episode.
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
        conversationId: conversationScope,
      })
    },

    goalDecomposed(conversationScope: string, goalTree: GoalTree): void {
      // Goal decomposition replaces the simple task with the real goal tree.
      // Settle the most-recent in-flight simple node to a terminal Kanban state
      // first (LIFO — it is the card being decomposed) so the superseded `req-…`
      // card doesn't linger "executing" (it is being replaced by a richer
      // representation, not failed). Then emit the decomposed tree UNDER THE
      // EPISODE ROOT (not the goal tree's own rootId) so decomposition grows THIS
      // board rather than spraying a sibling root.
      const episode = episodes.get(conversationScope)
      const nodeId = episode?.simpleNodeIds.pop()
      if (episode && nodeId) {
        workspaceBus.emit('monitor:task_update', {
          rootId: episode.episodeId,
          nodeId,
          status: 'completed',
          conversationId: conversationScope,
        })
      }
      const payload = goalTreeToDagPayload(goalTree, conversationScope)
      workspaceBus.emit('monitor:dag_init', withEpisodeRoot(payload, episode))
    },

    goalRestructured(conversationScope: string, goalTree: GoalTree): void {
      // Restructure lands on the SAME episode board (rootId overridden to the
      // episodeId) so a reactive re-plan updates this workspace in place.
      const episode = episodes.get(conversationScope)
      const payload = goalTreeToDagPayload(goalTree, conversationScope)
      workspaceBus.emit('monitor:dag_restructure', withEpisodeRoot(payload, episode))
    },

    requestEnd(conversationScope: string, failed = false): void {
      const episode = episodes.get(conversationScope)
      if (!episode) return // No active episode for this scope — no-op
      // Settle this request's simple node (the most-recent in-flight card, LIFO),
      // if any remains un-superseded by decomposition. Tracking each request's
      // card separately means a concurrent same-scope request (e.g. interactive +
      // background) still has its OWN card settled rather than one card lingering
      // "executing" because a single shared slot was overwritten.
      const nodeId = episode.simpleNodeIds.pop()
      if (nodeId) {
        workspaceBus.emit('monitor:task_update', {
          rootId: episode.episodeId,
          nodeId,
          status: failed ? 'failed' : 'completed',
          conversationId: conversationScope,
        })
      }
      // Mark the episode terminal (keep the entry) so the next request rolls over
      // to a fresh episode/workspace even if it arrives on the same tick.
      episode.terminal = true
    },
  }

  return lifecycle
}
