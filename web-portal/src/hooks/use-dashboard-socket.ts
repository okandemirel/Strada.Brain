import { toast } from 'sonner'
import { useMonitorStore } from '../stores/monitor-store'
import { useWorkspaceStore, type WorkspaceMode } from '../stores/workspace-store'
import { useCanvasStore, type CanvasLayout, type CanvasViewport } from '../stores/canvas-store'
import { useCodeStore } from '../stores/code-store'
import { useSupervisorStore } from '../stores/supervisor-store'
import { normalizeCanvasIncomingShapes } from '../components/canvas/canvas-shape-normalizer'
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
  nodeId: string
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

/** Helper to safely read a property from an untyped payload bag. */
type Bag = Record<string, unknown>

function suggestCanvasMode(): void {
  const wsStore = useWorkspaceStore.getState()
  if (!wsStore.userOverride && wsStore.mode !== 'canvas') {
    wsStore.suggestMode('canvas')
  }
}

/**
 * Dispatches a workspace/monitor message to the appropriate Zustand stores.
 * This is a pure function (no hooks) so it can be called from the WS message handler
 * and tested independently.
 */
export function dispatchWorkspaceMessage(data: { type: string; [key: string]: unknown }): void {
  // All events from monitor-bridge arrive wrapped as { type, payload, timestamp }.
  // Unwrap consistently for all cases.
  const payload = (data.payload ?? data) as Bag

  switch (data.type) {
    case 'monitor:dag_init': {
      const monitor = useMonitorStore.getState()
      monitor.setActiveRootId(payload.rootId as string)
      const dag = (payload.dag ?? { nodes: payload.nodes, edges: payload.edges }) as Bag
      monitor.setDAG(dag as unknown as DagState)
      const nodes = (dag.nodes ?? []) as Bag[]
      for (const node of nodes) {
        monitor.addTask({
          id: node.id as string,
          nodeId: node.id as string,
          rootId: payload.rootId as string,
          title: (node.title ?? node.task ?? node.id) as string,
          status: node.status as string,
          reviewStatus: node.reviewStatus as string,
          ...((node.dependencies || node.dependsOn) ? { dependencies: (node.dependencies ?? node.dependsOn) as string[] } : {}),
        })
      }
      break
    }

    case 'monitor:task_update': {
      const src = (payload.updates ?? payload) as Bag
      const updates: Partial<MonitorTask> = {}
      if (typeof payload.rootId === 'string') updates.rootId = payload.rootId
      if (typeof src.status === 'string') updates.status = src.status
      if (typeof src.reviewStatus === 'string') updates.reviewStatus = src.reviewStatus
      if (typeof src.agentId === 'string') updates.agentId = src.agentId
      if (typeof src.phase === 'string') updates.phase = src.phase as MonitorTask['phase']
      if (typeof src.startedAt === 'number') updates.startedAt = src.startedAt
      if (typeof src.completedAt === 'number') updates.completedAt = src.completedAt
      if (typeof src.elapsed === 'number') updates.elapsed = src.elapsed
      if (typeof src.error === 'string') updates.narrative = src.error
      if (src.progress && typeof src.progress === 'object') updates.progress = src.progress as MonitorTask['progress']
      useMonitorStore.getState().updateTask((payload.taskId ?? payload.nodeId) as string, updates)
      break
    }

    case 'monitor:agent_activity': {
      useMonitorStore.getState().addActivity((payload.activity ?? payload) as ActivityEntry)
      break
    }

    case 'monitor:substep': {
      const nodeId = (payload.nodeId ?? payload.taskId) as string
      const substep = payload.substep as NonNullable<MonitorTask['substeps']>[number]
      if (nodeId && substep) {
        // Auto-create placeholder task if substep arrives before dag_init (race condition)
        if (!useMonitorStore.getState().tasks[nodeId]) {
          useMonitorStore.getState().addTask({
            id: nodeId,
            nodeId,
            title: nodeId,
            status: 'executing',
            reviewStatus: 'none',
          })
        }
        // Re-read after potential addTask to get fresh state
        const task = useMonitorStore.getState().tasks[nodeId]
        if (task) {
          const existing = task.substeps ?? []
          const idx = existing.findIndex((s) => s.id === substep.id)
          const merged = idx >= 0
            ? [...existing.slice(0, idx), { ...existing[idx], ...substep }, ...existing.slice(idx + 1)]
            : [...existing, substep]
          useMonitorStore.getState().updateTask(nodeId, { substeps: merged })
        }
      }
      break
    }

    case 'progress:narrative': {
      const narrative = (payload.narrative as string) ?? ''
      const nodeId = payload.nodeId as string | undefined
      const milestone = payload.milestone as
        | { current: number; total: number; label: string }
        | undefined

      if (nodeId) {
        useMonitorStore.getState().updateTask(nodeId, {
          narrative,
          ...(milestone ? { milestone } : {}),
        })
      }

      useMonitorStore.getState().addActivity({
        taskId: nodeId,
        action: 'progress_narrative',
        detail: narrative,
        timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
      })
      break
    }

    case 'monitor:clear': {
      useMonitorStore.getState().clearMonitor()
      break
    }

    case 'workspace:mode_suggest': {
      const ws = useWorkspaceStore.getState()
      const prevMode = ws.mode
      ws.suggestMode(payload.mode as WorkspaceMode)
      // Show toast only if mode actually changed
      if (!ws.userOverride && payload.mode !== prevMode) {
        ws.addNotification({
          kind: 'mode_suggest',
          title: 'Mode switched',
          message: (payload.reason as string) ?? `Switched to ${payload.mode}`,
          severity: 'info',
        })
        toast.info((payload.reason as string) ?? `Switched to ${payload.mode}`, {
          action: {
            label: 'Undo',
            onClick: () => useWorkspaceStore.getState().undoModeSwitch(),
          },
        })
      }
      break
    }

    case 'workspace:notification': {
      useWorkspaceStore.getState().addNotification({
        title: (payload.title as string) ?? '',
        message: (payload.message as string) ?? '',
        severity: (payload.severity as 'info' | 'warning' | 'error') ?? 'info',
      })
      const sev = (payload.severity as string) ?? 'info'
      const msg = (payload.message as string) ?? ''
      if (sev === 'error') toast.error(msg)
      else if (sev === 'warning') toast.warning(msg)
      else toast.info(msg)
      break
    }

    case 'canvas:shapes_add': {
      const shapes = normalizeCanvasIncomingShapes(
        ((payload.shapes as Array<{ type?: string; id: string; props: Record<string, unknown>; position?: { x: number; y: number } }>) || []).map((shape) => ({
          ...shape,
          source: 'agent' as const,
        })),
      )
      useCanvasStore.getState().addPendingShapes(shapes)
      suggestCanvasMode()
      break
    }

    case 'canvas:shapes_update':
      useCanvasStore.getState().updatePendingShapes(
        normalizeCanvasIncomingShapes(
          ((payload.shapes as Array<{ type?: string; id: string; props: Record<string, unknown>; position?: { x: number; y: number } }>) || []).map((shape) => ({
            ...shape,
            source: 'agent' as const,
          })),
        ),
      )
      suggestCanvasMode()
      break

    case 'canvas:shapes_remove':
      useCanvasStore.getState().removePendingShapeIds((payload.shapeIds as string[]) || [])
      suggestCanvasMode()
      break

    case 'canvas:viewport':
      useCanvasStore.getState().setPendingViewport(payload as unknown as CanvasViewport)
      suggestCanvasMode()
      break

    case 'canvas:arrange':
      useCanvasStore.getState().setPendingLayout((payload.layout as CanvasLayout | undefined) ?? 'auto')
      suggestCanvasMode()
      break

    case 'canvas:agent_draw': {
      const shapes = normalizeCanvasIncomingShapes(
        ((payload.shapes as Array<{ type?: string; id: string; props: Record<string, unknown>; position?: { x: number; y: number } }>) || []).map((shape) => ({
          ...shape,
          source: 'agent' as const,
        })),
      )
      const action = payload.action as string | undefined
      const autoSwitch = payload.autoSwitch !== false

      if (action === 'clear') {
        useCanvasStore.getState().removePendingShapeIds(shapes.map((shape) => shape.id))
      } else if (action === 'update' || action === 'annotate' || action === 'highlight') {
        useCanvasStore.getState().updatePendingShapes(shapes)
      } else {
        useCanvasStore.getState().addPendingShapes(shapes)
      }

      // Only auto-select if user hasn't manually chosen a layout
      const canvasState = useCanvasStore.getState()
      if (!canvasState.userLayoutOverride) {
        const intent = payload.intent as string | undefined
        if (intent?.includes('plan') || intent?.includes('supervisor')) {
          canvasState.setLayoutMode('flow')
          // Reset override since this was auto-set, not user-set
          useCanvasStore.setState({ userLayoutOverride: false })
        }
      }

      if (payload.viewport) {
        useCanvasStore.getState().setPendingViewport(payload.viewport as unknown as CanvasViewport)
      }
      if (payload.layout) {
        useCanvasStore.getState().setPendingLayout(payload.layout as CanvasLayout)
      }

      if (autoSwitch) {
        suggestCanvasMode()
      }
      break
    }

    case 'monitor:gate_request': {
      if (payload.nodeId) {
        useMonitorStore.getState().updateTask(payload.nodeId as string, { reviewStatus: 'review_stuck' })
      }
      break
    }

    case 'monitor:review_result': {
      if (payload.nodeId) {
        useMonitorStore.getState().updateTask(payload.nodeId as string, {
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
        if (payload.rootId) monitor.setActiveRootId(payload.rootId as string)
        monitor.setDAG({ nodes: payload.nodes, edges: payload.edges } as unknown as DagState)
        const existingTasks = monitor.tasks
        const nodes = payload.nodes as Bag[]
        for (const node of nodes) {
          const id = node.id as string
          if (existingTasks[id]) {
            // Merge: preserve in-flight status from task_update events
            monitor.updateTask(id, {
              ...(payload.rootId ? { rootId: payload.rootId as string } : {}),
              title: (node.title ?? node.task ?? node.id) as string,
              ...((node.dependencies || node.dependsOn) ? { dependencies: (node.dependencies ?? node.dependsOn) as string[] } : {}),
            })
          } else {
            monitor.addTask({
              id,
              nodeId: id,
              ...(payload.rootId ? { rootId: payload.rootId as string } : {}),
              title: (node.title ?? node.task ?? node.id) as string,
              status: node.status as string,
              reviewStatus: node.reviewStatus as string,
              ...((node.dependencies || node.dependsOn) ? { dependencies: (node.dependencies ?? node.dependsOn) as string[] } : {}),
            })
          }
        }
      }
      break
    }

    case 'code:file_open': {
      const store = useCodeStore.getState()
      store.openFile({
        path: payload.path as string,
        content: (payload.content as string) ?? '',
        language: (payload.language as string) ?? 'plaintext',
      })
      const touchedStatus = payload.touchedStatus as 'modified' | 'new' | 'deleted' | undefined
      if (touchedStatus) {
        store.markTouched(payload.path as string, touchedStatus)
      }
      const wsStore = useWorkspaceStore.getState()
      if (!wsStore.userOverride && wsStore.mode !== 'code') {
        wsStore.suggestMode('code')
      }
      break
    }

    case 'code:file_update': {
      const store = useCodeStore.getState()
      const existing = store.tabs.find((t) => t.path === payload.path)
      store.openFile({
        path: payload.path as string,
        content: existing?.content ?? '',
        language: (payload.language as string) ?? existing?.language ?? 'plaintext',
        isDiff: true,
        diffContent: payload.diff as string,
        originalContent: (payload.original as string) ?? existing?.content ?? '',
        modifiedContent: (payload.modified as string) ?? '',
      })
      store.markTouched(payload.path as string, 'modified')
      // Auto-switch to code workspace when diff arrives
      const wsStore = useWorkspaceStore.getState()
      if (!wsStore.userOverride && wsStore.mode !== 'code') {
        wsStore.suggestMode('code')
      }
      break
    }

    case 'code:terminal_output': {
      const prefix = payload.command ? `$ ${payload.command}\n` : ''
      useCodeStore.getState().appendTerminal(prefix + ((payload.content as string) ?? ''))
      break
    }

    case 'code:terminal_clear': {
      useCodeStore.getState().clearTerminal()
      break
    }

    case 'code:annotation_add': {
      useCodeStore.getState().addAnnotation({
        path: payload.path as string,
        line: payload.line as number,
        message: payload.message as string,
        severity: (payload.severity as 'info' | 'warning' | 'error') ?? 'info',
      })
      break
    }

    case 'code:annotation_clear': {
      useCodeStore.getState().clearAnnotations(payload.path as string)
      break
    }

    // === Supervisor events ===

    case 'supervisor:activated': {
      useSupervisorStore.getState().activate(
        payload.taskId as string,
        payload.nodeCount as number,
      )
      break
    }

    case 'supervisor:plan_ready': {
      useSupervisorStore.getState().setPlan(
        payload.assignments as Record<string, { provider: string; model: string }>,
      )
      break
    }

    case 'supervisor:wave_start': {
      useSupervisorStore.getState().setWaveStart(
        payload.waveIndex as number,
        payload.nodes as Array<{ nodeId: string; provider: string }>,
      )
      break
    }

    case 'supervisor:node_start': {
      useSupervisorStore.getState().updateNode(payload.nodeId as string, {
        status: 'running',
        provider: payload.provider as string,
        model: payload.model as string,
        wave: payload.wave as number,
      })
      break
    }

    case 'supervisor:node_complete': {
      useSupervisorStore.getState().updateNode(payload.nodeId as string, {
        status: payload.status as string,
        duration: payload.duration as number,
        cost: payload.cost as number,
      })
      break
    }

    case 'supervisor:node_failed': {
      const sup = useSupervisorStore.getState()
      sup.updateNode(payload.nodeId as string, { status: 'failed' })
      sup.addAlert({
        kind: 'failed',
        nodeId: payload.nodeId as string,
        message: `${payload.error as string} (level ${payload.failureLevel}, ${payload.nextAction})`,
      })
      break
    }

    case 'supervisor:escalation': {
      useSupervisorStore.getState().addAlert({
        kind: 'escalation',
        nodeId: payload.nodeId as string,
        message: `${payload.fromProvider} -> ${payload.toProvider}: ${payload.reason}`,
      })
      break
    }

    case 'supervisor:wave_done': {
      // Update node statuses from wave results
      const store = useSupervisorStore.getState()
      const results = (payload.results ?? []) as Array<{ nodeId: string; status: string }>
      for (const r of results) {
        store.updateNode(r.nodeId, { status: r.status })
      }
      break
    }

    case 'supervisor:verify_start': {
      useSupervisorStore.getState().updateNode(payload.nodeId as string, {
        status: 'verifying',
      })
      break
    }

    case 'supervisor:verify_done': {
      useSupervisorStore.getState().updateNode(payload.nodeId as string, {
        status: 'done',
        verdict: payload.verdict as string,
      })
      break
    }

    case 'supervisor:complete': {
      useSupervisorStore.getState().setComplete({
        totalNodes: payload.totalNodes as number,
        succeeded: payload.succeeded as number,
        failed: payload.failed as number,
        skipped: payload.skipped as number,
        cost: payload.cost as number,
        duration: payload.duration as number,
      })
      break
    }

    case 'supervisor:aborted': {
      useSupervisorStore.getState().setAborted()
      break
    }

    // === Budget events ===

    case 'budget:warning': {
      const pct = typeof payload.pct === 'number' ? Math.round(payload.pct * 100) : '?'
      const source = (payload.source as string) ?? 'global'
      toast.warning(`Budget at ${pct}% — ${source} spending approaching limit`)
      break
    }

    case 'budget:exceeded': {
      const isGlobal = (payload.isGlobal as boolean) ?? true
      const source = (payload.source as string) ?? 'global'
      toast.error(isGlobal
        ? 'Budget exceeded — all systems paused'
        : `Budget exceeded — ${source} paused`)
      break
    }

    case 'notification': {
      const notifType = payload.type as string | undefined
      if (notifType === 'budget:warning') {
        const inner = (payload.data as Bag | undefined) ?? payload
        const pct = typeof inner.pct === 'number' ? Math.round(inner.pct * 100) : '?'
        const source = (inner.source as string) ?? 'global'
        toast.warning(`Budget at ${pct}% — ${source} spending approaching limit`)
      } else if (notifType === 'budget:exceeded') {
        const inner = (payload.data as Bag | undefined) ?? payload
        const isGlobal = (inner.isGlobal as boolean) ?? true
        const source = (inner.source as string) ?? 'global'
        toast.error(isGlobal
          ? 'Budget exceeded — all systems paused'
          : `Budget exceeded — ${source} paused`)
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
  return type.startsWith('monitor:')
    || type.startsWith('workspace:')
    || type.startsWith('canvas:')
    || type.startsWith('code:')
    || type.startsWith('supervisor:')
    || type.startsWith('progress:')
    || type.startsWith('budget:')
    || type === 'notification'
}
