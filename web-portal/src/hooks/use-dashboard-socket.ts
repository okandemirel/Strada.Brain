import { useMonitorStore } from '../stores/monitor-store'
import { useWorkspaceStore, type WorkspaceMode } from '../stores/workspace-store'
import { useCanvasStore } from '../stores/canvas-store'
import type { MonitorTask, ActivityEntry, DagState } from '../stores/monitor-store'

// ---- Workspace message type definitions ----

export interface MonitorDagInitMessage {
  type: 'monitor:dag_init'
  rootId: string
  dag: {
    nodes: Array<{ id: string; title: string; status: string; reviewStatus: string; [key: string]: unknown }>
    edges: Array<{ source: string; target: string }>
  }
}

export interface MonitorTaskUpdateMessage {
  type: 'monitor:task_update'
  taskId: string
  updates: Partial<MonitorTask>
}

export interface MonitorAgentActivityMessage {
  type: 'monitor:agent_activity'
  activity: ActivityEntry
}

export interface MonitorClearMessage {
  type: 'monitor:clear'
}

export interface WorkspaceModeSuggestMessage {
  type: 'workspace:mode_suggest'
  mode: WorkspaceMode
}

export type WorkspaceMessage =
  | MonitorDagInitMessage
  | MonitorTaskUpdateMessage
  | MonitorAgentActivityMessage
  | MonitorClearMessage
  | WorkspaceModeSuggestMessage

/**
 * Dispatches a workspace/monitor message to the appropriate Zustand stores.
 * This is a pure function (no hooks) so it can be called from the WS message handler
 * and tested independently.
 */
export function dispatchWorkspaceMessage(data: { type: string; [key: string]: unknown }): void {
  switch (data.type) {
    case 'monitor:dag_init': {
      const msg = data as unknown as MonitorDagInitMessage
      const monitor = useMonitorStore.getState()
      monitor.setActiveRootId(msg.rootId)
      monitor.setDAG(msg.dag as DagState)
      for (const node of msg.dag.nodes) {
        monitor.addTask({
          id: node.id,
          nodeId: node.id,
          title: (node as any).title ?? (node as any).task ?? node.id,
          status: node.status,
          reviewStatus: node.reviewStatus,
          ...(node.dependencies ? { dependencies: node.dependencies as string[] } : {}),
        })
      }
      break
    }

    case 'monitor:task_update': {
      const msg = data as unknown as MonitorTaskUpdateMessage
      useMonitorStore.getState().updateTask(msg.taskId, msg.updates)
      break
    }

    case 'monitor:agent_activity': {
      const msg = data as unknown as MonitorAgentActivityMessage
      useMonitorStore.getState().addActivity(msg.activity)
      break
    }

    case 'monitor:clear': {
      useMonitorStore.getState().clearMonitor()
      break
    }

    case 'workspace:mode_suggest': {
      const msg = data as unknown as WorkspaceModeSuggestMessage
      useWorkspaceStore.getState().suggestMode(msg.mode)
      break
    }

    case 'canvas:shapes_add':
      useCanvasStore.getState().addPendingShapes((data as any).shapes || [])
      break

    case 'canvas:shapes_update':
      useCanvasStore.getState().addPendingShapes((data as any).shapes || [])
      break

    case 'canvas:shapes_remove':
      // Shape removal is handled by the canvas component itself via the store
      break

    case 'monitor:gate_request': {
      const payload = (data as any).payload ?? data
      if (payload.nodeId) {
        useMonitorStore.getState().updateTask(payload.nodeId, { reviewStatus: 'review_stuck' })
      }
      break
    }

    case 'monitor:review_result': {
      const payload = (data as any).payload ?? data
      if (payload.nodeId) {
        useMonitorStore.getState().updateTask(payload.nodeId, {
          reviewStatus: payload.passed ? 'passed' : 'failed',
          ...(payload.reviewType === 'spec_review' ? { specReviewResult: payload } : {}),
          ...(payload.reviewType === 'quality_review' ? { qualityReviewResult: payload } : {}),
        })
      }
      break
    }

    case 'monitor:dag_restructure': {
      const payload = (data as any).payload ?? data
      const monitor = useMonitorStore.getState()
      if (payload.nodes && payload.edges) {
        monitor.setDAG({ nodes: payload.nodes, edges: payload.edges } as DagState)
        for (const node of payload.nodes) {
          monitor.addTask({
            id: node.id,
            nodeId: node.id,
            title: (node as any).title ?? (node as any).task ?? node.id,
            status: node.status,
            reviewStatus: node.reviewStatus,
            ...(node.dependencies ? { dependencies: node.dependencies as string[] } : {}),
          })
        }
      }
      break
    }

    default:
      // Unknown workspace message type — ignore
      break
  }
}

/**
 * Returns true if a parsed WS message type is a workspace/monitor message
 * that should be dispatched via dispatchWorkspaceMessage.
 */
export function isWorkspaceMessage(type: string): boolean {
  return type.startsWith('monitor:') || type.startsWith('workspace:') || type.startsWith('canvas:')
}
