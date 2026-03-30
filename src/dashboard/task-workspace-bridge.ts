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

export function createTaskWorkspaceBridge(
  taskManager: EventEmitter,
  workspaceBus: IEventBus<WorkspaceEventMap>,
): WorkspaceBridge {
  const listeners: Array<() => void> = []

  return {
    start() {
      const onCreated = (task: { id: string; title?: string; prompt?: string }) => {
        workspaceBus.emit('monitor:agent_activity', {
          taskId: task.id,
          action: 'task_created',
          detail: `Task started: ${task.title ?? task.prompt?.slice(0, 80) ?? task.id}`,
          timestamp: Date.now(),
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
        })
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
        })
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
        })
      }
      taskManager.on('task:cancelled', onCancelled)
      listeners.push(() => taskManager.off('task:cancelled', onCancelled))
    },

    stop() {
      for (const unsub of listeners) unsub()
      listeners.length = 0
    },
  }
}
