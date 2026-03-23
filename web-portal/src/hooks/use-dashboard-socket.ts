import { useMonitorStore } from '../stores/monitor-store'
import { useWorkspaceStore, type WorkspaceMode } from '../stores/workspace-store'
import { useCanvasStore } from '../stores/canvas-store'
import { useCodeStore } from '../stores/code-store'
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
  // All events from monitor-bridge arrive wrapped as { type, payload, timestamp }.
  // Unwrap consistently for all cases.
  const payload = (data as any).payload ?? data

  switch (data.type) {
    case 'monitor:dag_init': {
      const monitor = useMonitorStore.getState()
      monitor.setActiveRootId(payload.rootId)
      const dag = payload.dag ?? { nodes: payload.nodes, edges: payload.edges }
      monitor.setDAG(dag as DagState)
      for (const node of (dag.nodes ?? [])) {
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
      useMonitorStore.getState().updateTask(payload.taskId, payload.updates ?? payload)
      break
    }

    case 'monitor:agent_activity': {
      useMonitorStore.getState().addActivity(payload.activity ?? payload)
      break
    }

    case 'monitor:clear': {
      useMonitorStore.getState().clearMonitor()
      break
    }

    case 'workspace:mode_suggest': {
      useWorkspaceStore.getState().suggestMode(payload.mode)
      break
    }

    case 'workspace:notification': {
      useWorkspaceStore.getState().addNotification({
        title: payload.title ?? '',
        message: payload.message ?? '',
        severity: payload.severity ?? 'info',
      })
      break
    }

    case 'canvas:shapes_add':
      useCanvasStore.getState().addPendingShapes(payload.shapes || [])
      break

    case 'canvas:shapes_update':
      useCanvasStore.getState().updatePendingShapes(payload.shapes || [])
      break

    case 'canvas:shapes_remove':
      useCanvasStore.getState().removePendingShapeIds(payload.shapeIds || [])
      break

    case 'monitor:gate_request': {
      if (payload.nodeId) {
        useMonitorStore.getState().updateTask(payload.nodeId, { reviewStatus: 'review_stuck' })
      }
      break
    }

    case 'monitor:review_result': {
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

    case 'code:file_open': {
      const payload = (data as any).payload ?? data
      const store = useCodeStore.getState()
      store.openFile({
        path: payload.path,
        content: payload.content ?? '',
        language: payload.language ?? 'plaintext',
      })
      store.markTouched(payload.path, 'new')
      break
    }

    case 'code:file_update': {
      const payload = (data as any).payload ?? data
      const store = useCodeStore.getState()
      const existing = store.tabs.find((t) => t.path === payload.path)
      store.openFile({
        path: payload.path,
        content: existing?.content ?? '',
        language: existing?.language ?? 'plaintext',
        isDiff: true,
        diffContent: payload.diff,
      })
      store.markTouched(payload.path, 'modified')
      break
    }

    case 'code:terminal_output': {
      const payload = (data as any).payload ?? data
      const prefix = payload.command ? `$ ${payload.command}\n` : ''
      useCodeStore.getState().appendTerminal(prefix + (payload.content ?? ''))
      break
    }

    case 'code:terminal_clear': {
      useCodeStore.getState().clearTerminal()
      break
    }

    case 'code:annotation_add': {
      const payload = (data as any).payload ?? data
      useCodeStore.getState().addAnnotation({
        path: payload.path,
        line: payload.line,
        message: payload.message,
        severity: payload.severity ?? 'info',
      })
      break
    }

    case 'code:annotation_clear': {
      const payload = (data as any).payload ?? data
      useCodeStore.getState().clearAnnotations(payload.path)
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
  return type.startsWith('monitor:') || type.startsWith('workspace:') || type.startsWith('canvas:') || type.startsWith('code:')
}
