import type { IEventBus } from '../core/event-bus.js'
import type { LearningEventMap } from '../core/event-bus.js'
import type { DaemonEventMap } from '../daemon/daemon-events.js'
import type { WorkspaceEventMap } from './workspace-events.js'

export interface WorkspaceBridge {
  start(): void
  stop(): void
}

export function createLearningWorkspaceBridge(
  learningBus: IEventBus<LearningEventMap>,
  daemonBus: IEventBus<DaemonEventMap>,
  workspaceBus: IEventBus<WorkspaceEventMap>,
): WorkspaceBridge {
  const listeners: Array<() => void> = []

  return {
    start() {
      // tool:result → monitor:agent_activity
      const onToolResult = (event: LearningEventMap['tool:result']) => {
        // Forward taskId when the event carries one (e.g. from supervisor node execution)
        const taskId = (event as unknown as Record<string, unknown>).taskId;
        workspaceBus.emit('monitor:agent_activity', {
          taskId: typeof taskId === 'string' ? taskId : undefined,
          action: 'tool_execute',
          tool: event.toolName,
          detail: `${event.toolName}: ${event.success ? 'success' : 'failed'}`,
          timestamp: event.timestamp,
        })
      }
      learningBus.on('tool:result', onToolResult)
      listeners.push(() => learningBus.off('tool:result', onToolResult))

      // goal:status-changed → monitor:task_update
      const onGoalStatus = (event: LearningEventMap['goal:status-changed']) => {
        workspaceBus.emit('monitor:task_update', {
          rootId: event.rootId,
          nodeId: event.nodeId,
          status: event.status,
        })
      }
      learningBus.on('goal:status-changed', onGoalStatus)
      listeners.push(() => learningBus.off('goal:status-changed', onGoalStatus))

      // goal:started → workspace:mode_suggest
      const onGoalStarted = (event: DaemonEventMap['goal:started']) => {
        workspaceBus.emit('workspace:mode_suggest', {
          mode: 'monitor',
          reason: `Goal started: ${event.taskDescription}`,
        })
      }
      daemonBus.on('goal:started', onGoalStarted)
      listeners.push(() => daemonBus.off('goal:started', onGoalStarted))

      // budget:warning → budget:warning on workspace bus
      const onBudgetWarning = (event: DaemonEventMap['budget:warning']) => {
        workspaceBus.emit('budget:warning', event)
      }
      daemonBus.on('budget:warning', onBudgetWarning)
      listeners.push(() => daemonBus.off('budget:warning', onBudgetWarning))

      // budget:exceeded → budget:exceeded on workspace bus
      const onBudgetExceeded = (event: DaemonEventMap['budget:exceeded']) => {
        workspaceBus.emit('budget:exceeded', event)
      }
      daemonBus.on('budget:exceeded', onBudgetExceeded)
      listeners.push(() => daemonBus.off('budget:exceeded', onBudgetExceeded))
    },

    stop() {
      for (const unsub of listeners) unsub()
      listeners.length = 0
    },
  }
}
