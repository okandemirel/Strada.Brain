/**
 * Monitor Lifecycle Manager
 *
 * Ensures the web portal monitor workspace (DAG + Kanban) always reflects
 * the current agent activity. Emits a simple single-node DAG for every
 * user request so the UI is never empty. When goal decomposition produces
 * a multi-node tree, it seamlessly replaces the simple representation.
 *
 * Lifecycle:
 *   requestStart  → single-node DAG emitted (status: executing)
 *   goalDecomposed → multi-node DAG replaces simple node (clears tracking)
 *   requestEnd     → simple node updated to completed/failed (no-op if decomposed)
 */

import type { WorkspaceBus } from './workspace-bus.js'
import type { GoalTree } from '../goals/types.js'
import { goalTreeToDagPayload, type DagNodeShape } from './workspace-events.js'

export interface MonitorLifecycle {
  /** Emit a simple single-node DAG when a user request starts processing. */
  requestStart(conversationScope: string, userMessage: string): void
  /** Replace the simple DAG with a decomposed goal tree. */
  goalDecomposed(conversationScope: string, goalTree: GoalTree): void
  /** Emit DAG restructure for an existing goal tree. */
  goalRestructured(conversationScope: string, goalTree: GoalTree): void
  /** Mark the simple task as completed (no-op if goal was decomposed). */
  requestEnd(conversationScope: string, failed?: boolean): void
}

const MAX_TASK_LABEL = 200

function generateTaskId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '\u2026' : text
}

export function createMonitorLifecycle(workspaceBus: WorkspaceBus): MonitorLifecycle {
  // Track active simple-task IDs per conversation scope.
  // Cleared when goal decomposition replaces the simple task.
  const activeSimpleTaskIds = new Map<string, string>()

  return {
    requestStart(conversationScope: string, userMessage: string): void {
      const taskId = generateTaskId()
      activeSimpleTaskIds.set(conversationScope, taskId)

      const node: DagNodeShape = {
        id: taskId,
        task: truncate(userMessage, MAX_TASK_LABEL),
        status: 'executing',
        reviewStatus: 'none',
        depth: 1,
        dependsOn: [],
      }

      workspaceBus.emit('monitor:dag_init', {
        rootId: taskId,
        nodes: [node],
        edges: [],
      })
    },

    goalDecomposed(conversationScope: string, goalTree: GoalTree): void {
      // Goal decomposition replaces the simple task — stop tracking it
      activeSimpleTaskIds.delete(conversationScope)
      workspaceBus.emit('monitor:dag_init', goalTreeToDagPayload(goalTree))
    },

    goalRestructured(conversationScope: string, goalTree: GoalTree): void {
      // Restructure doesn't affect simple task tracking (already cleared by goalDecomposed)
      workspaceBus.emit('monitor:dag_restructure', goalTreeToDagPayload(goalTree))
    },

    requestEnd(conversationScope: string, failed = false): void {
      const taskId = activeSimpleTaskIds.get(conversationScope)
      if (!taskId) return // Already decomposed or not started — no-op
      activeSimpleTaskIds.delete(conversationScope)

      workspaceBus.emit('monitor:task_update', {
        rootId: taskId,
        nodeId: taskId,
        status: failed ? 'failed' : 'completed',
      })
    },
  }
}
