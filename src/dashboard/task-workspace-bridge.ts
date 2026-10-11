/**
 * Task → Workspace Bridge
 *
 * Bridges TaskManager events (Node.js EventEmitter) to WorkspaceBus so
 * the web portal dashboard receives real-time task lifecycle updates.
 *
 * Similar to learning-workspace-bridge.ts but for the task system.
 */

import type { EventEmitter } from 'node:events'
import type { IEventBus } from '../core/event-bus.js'
import type { WorkspaceEventMap } from './workspace-events.js'
import type { TaskProgressUpdate } from '../tasks/types.js'
import { getTaskProgressMessage } from '../tasks/progress-signals.js'
import type { WorkspaceBridge } from './learning-workspace-bridge.js'
import { taskOrigin } from './monitor-read-scope.js'

/** The fields that say whose request a task is (see taskOrigin). */
interface TaskScope {
  readonly chatId: string
  readonly userId?: string
}

/**
 * TaskManager.getStatus: the scope of a task this bridge did not see created —
 * one recovered after a restart, or one evicted from the bound below.
 */
interface TaskScopeLookup {
  getStatus?(taskId: string): TaskScope | null
}

/** Bound on remembered task→scope pairs; a miss falls back to the lookup. */
const MAX_REMEMBERED_TASKS = 1_000

export function createTaskWorkspaceBridge(
  taskManager: EventEmitter & TaskScopeLookup,
  workspaceBus: IEventBus<WorkspaceEventMap>,
): WorkspaceBridge {
  const listeners: Array<() => void> = []

  // dashboard#3: these frames quote the request ("Task started: <title>" is
  // its first 80 characters) and its failures. Emitted with no scope, the
  // monitor bridge could not stamp an origin, so every portal identity got
  // another's request text, live, on reconnect replay and from the activity
  // REST route. Each frame names the task owner's scope instead.
  const scopes = new Map<string, string>()

  function remember(taskId: string, scope: string): void {
    scopes.delete(taskId)
    scopes.set(taskId, scope)
    if (scopes.size > MAX_REMEMBERED_TASKS) {
      const oldest = scopes.keys().next().value
      if (oldest !== undefined) scopes.delete(oldest)
    }
  }

  function scopeOf(taskId: string): { conversationId?: string } {
    let scope = scopes.get(taskId)
    if (scope === undefined) {
      let task: TaskScope | null | undefined
      try {
        task = taskManager.getStatus?.(taskId)
      } catch {
        task = undefined
      }
      if (task?.chatId) {
        scope = taskOrigin(task)
        remember(taskId, scope)
      }
    }
    return scope ? { conversationId: scope } : {}
  }

  return {
    start() {
      const onCreated = (task: { id: string; chatId?: string; userId?: string; title?: string; prompt?: string }) => {
        if (task.chatId) remember(task.id, taskOrigin({ chatId: task.chatId, userId: task.userId }))
        workspaceBus.emit('monitor:agent_activity', {
          taskId: task.id,
          action: 'task_created',
          detail: `Task started: ${task.title ?? task.prompt?.slice(0, 80) ?? task.id}`,
          timestamp: Date.now(),
          ...scopeOf(task.id),
        })
      }
      taskManager.on('task:created', onCreated)
      listeners.push(() => taskManager.off('task:created', onCreated))

      const onProgress = (taskId: string, message: TaskProgressUpdate) => {
        workspaceBus.emit('monitor:agent_activity', {
          taskId,
          action: 'task_progress',
          detail: getTaskProgressMessage(message),
          timestamp: Date.now(),
          ...scopeOf(taskId),
        })
      }
      taskManager.on('task:progress', onProgress)
      listeners.push(() => taskManager.off('task:progress', onProgress))

      const onCompleted = (taskId: string, _result: string) => {
        workspaceBus.emit('monitor:agent_activity', {
          taskId,
          action: 'task_completed',
          detail: 'Task completed',
          timestamp: Date.now(),
          ...scopeOf(taskId),
        })
        scopes.delete(taskId)
        // Fallback: ensure monitor task node transitions to completed
        // even if monitorLifecycle.requestEnd was not called
        workspaceBus.emit('monitor:task_update', {
          rootId: taskId,
          nodeId: taskId,
          status: 'completed',
        })
      }
      taskManager.on('task:completed', onCompleted)
      listeners.push(() => taskManager.off('task:completed', onCompleted))

      const onFailed = (taskId: string, error: string) => {
        workspaceBus.emit('monitor:agent_activity', {
          taskId,
          action: 'task_failed',
          detail: `Task failed: ${error.slice(0, 120)}`,
          timestamp: Date.now(),
          ...scopeOf(taskId),
        })
        scopes.delete(taskId)
        workspaceBus.emit('monitor:task_update', {
          rootId: taskId,
          nodeId: taskId,
          status: 'failed',
        })
      }
      taskManager.on('task:failed', onFailed)
      listeners.push(() => taskManager.off('task:failed', onFailed))

      const onBlocked = (taskId: string, checkpoint: string) => {
        workspaceBus.emit('monitor:agent_activity', {
          taskId,
          action: 'task_blocked',
          detail: `Task blocked: ${checkpoint.slice(0, 120)}`,
          timestamp: Date.now(),
          ...scopeOf(taskId),
        })
        workspaceBus.emit('monitor:task_update', {
          rootId: taskId,
          nodeId: taskId,
          status: 'blocked',
        })
      }
      taskManager.on('task:blocked', onBlocked)
      listeners.push(() => taskManager.off('task:blocked', onBlocked))

      const onCancelled = (taskId: string) => {
        workspaceBus.emit('monitor:agent_activity', {
          taskId,
          action: 'task_cancelled',
          detail: 'Task cancelled',
          timestamp: Date.now(),
          ...scopeOf(taskId),
        })
        scopes.delete(taskId)
      }
      taskManager.on('task:cancelled', onCancelled)
      listeners.push(() => taskManager.off('task:cancelled', onCancelled))
    },

    stop() {
      for (const unsub of listeners) unsub()
      listeners.length = 0
      scopes.clear()
    },
  }
}
