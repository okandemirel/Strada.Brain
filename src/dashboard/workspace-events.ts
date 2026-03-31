import type { GoalTree } from '../goals/types.js'

export interface DagNodeShape {
  id: string
  task: string
  status: string
  reviewStatus: string
  depth: number
  dependsOn: string[]
}

export interface DagPayload {
  rootId: string
  nodes: DagNodeShape[]
  edges: Array<{ source: string; target: string }>
}

const MAX_TASK_LABEL_LENGTH = 200

/** Convert a GoalTree into the DAG payload used by monitor events. */
export function goalTreeToDagPayload(goalTree: GoalTree): DagPayload {
  const nodes: DagNodeShape[] = []
  const edges: Array<{ source: string; target: string }> = []
  for (const [id, node] of goalTree.nodes) {
    if (String(id) === String(goalTree.rootId)) continue
    const task = node.task.length > MAX_TASK_LABEL_LENGTH
      ? node.task.slice(0, MAX_TASK_LABEL_LENGTH) + '…'
      : node.task
    nodes.push({
      id: String(id),
      task,
      status: String(node.status),
      reviewStatus: String(node.reviewStatus ?? 'none'),
      depth: node.depth,
      dependsOn: node.dependsOn.map(String),
    })
    for (const dep of node.dependsOn) {
      edges.push({ source: String(dep), target: String(id) })
    }
  }
  return { rootId: String(goalTree.rootId), nodes, edges }
}

export interface WorkspaceEventMap {
  [key: string]: unknown
  // === Monitor events (Phase 3 — full payloads) ===
  'monitor:clear': Record<string, never>
  'monitor:dag_init': {
    rootId: string
    nodes: DagNodeShape[]
    edges: Array<{ source: string; target: string }>
  }
  'monitor:task_update': {
    rootId: string
    nodeId: string
    status: string
    error?: string
    reviewStatus?: string
    agentId?: string
    phase?: 'planning' | 'acting' | 'observing' | 'reflecting'
    progress?: { current: number; total: number; unit: string }
    elapsed?: number
    startedAt?: number
    completedAt?: number
  }
  'monitor:review_result': {
    rootId: string
    nodeId: string
    reviewType: 'spec_review' | 'quality_review'
    passed: boolean
    issues: Array<{ file?: string; line?: number; message: string; severity?: string }>
    iteration: number
    maxIterations: number
  }
  'monitor:agent_activity': {
    taskId?: string
    action: string
    tool?: string
    detail: string
    timestamp: number
  }
  'monitor:gate_request': {
    rootId: string
    nodeId: string
    gateType: 'review_stuck' | 'failure_budget' | 'user_approval'
    message: string
  }
  'monitor:dag_restructure': {
    rootId: string
    nodes: DagNodeShape[]
    edges: Array<{ source: string; target: string }>
  }
  'monitor:gate_response': {
    rootId: string
    nodeId: string
    action: 'approve' | 'skip'
    source: string
    timestamp: number
  }
  'monitor:retry_task': {
    rootId?: string
    nodeId?: string
    taskId?: string
  }
  'monitor:resume_task': {
    rootId?: string
    nodeId?: string
    taskId?: string
  }
  'monitor:cancel_task': {
    rootId?: string
    nodeId?: string
    taskId?: string
  }
  'monitor:move_task': {
    rootId?: string
    taskId?: string
    nodeId?: string
    fromColumn?: string
    toColumn?: string
    newStatus?: string
    newReviewStatus?: string
  }

  // === Canvas events (Phase 4 — typed payloads) ===
  'canvas:shapes_add': {
    shapes: Array<{ type: string; id: string; props: Record<string, unknown> }>
    layout?: 'auto' | 'grid' | 'tree' | 'flow'
  }
  'canvas:shapes_update': {
    shapes: Array<{ id: string; props: Record<string, unknown> }>
  }
  'canvas:shapes_remove': {
    shapeIds: string[]
  }
  'canvas:viewport': {
    x: number; y: number; zoom: number
  }
  'canvas:arrange': {
    layout: 'auto' | 'grid' | 'tree' | 'flow'
  }

  // === Canvas client-to-server events (Phase 4) ===
  'canvas:user_shapes': { snapshot: string }
  'canvas:save': { sessionId: string }

  // === Code events (Phase 5 — typed payloads) ===
  'code:file_open': {
    path: string
    content: string
    language: string
    touchedStatus?: 'modified' | 'new' | 'deleted'
  }
  'code:file_update': {
    path: string
    diff: string
    original: string
    modified: string
    language?: string
  }
  'code:terminal_output': {
    content: string
    command?: string
  }
  'code:terminal_clear': Record<string, never>
  'code:annotation_add': {
    path: string
    line: number
    message: string
    severity: 'error' | 'warning' | 'info'
  }
  'code:annotation_clear': {
    path: string
  }

  // === Code client-to-server events (Phase 5) ===
  'code:accept_diff': { path: string; hunkIndex: number }
  'code:reject_diff': { path: string; hunkIndex: number }
  'code:request_file': { path: string }

  // === Supervisor events (multi-agent DAG execution) ===
  'supervisor:activated': { taskId: string; complexity: string; nodeCount: number }
  'supervisor:plan_ready': { dag: { rootId: string; nodeCount: number }; assignments: Record<string, { provider: string; model: string }> }
  'supervisor:wave_start': { waveIndex: number; nodes: Array<{ nodeId: string; provider: string }> }
  'supervisor:node_start': { nodeId: string; provider: string; model: string; wave: number }
  'supervisor:node_complete': { nodeId: string; status: string; duration: number; cost: number }
  'supervisor:node_failed': { nodeId: string; error: string; failureLevel: number; nextAction: string }
  'supervisor:escalation': { nodeId: string; fromProvider: string; toProvider: string; reason: string }
  'supervisor:wave_done': { waveIndex: number; results: Array<{ nodeId: string; status: string }>; totalCost: number }
  'supervisor:verify_start': { nodeId: string; verifierProvider: string }
  'supervisor:verify_done': { nodeId: string; verdict: string; issues?: string[] }
  'supervisor:complete': { totalNodes: number; succeeded: number; failed: number; skipped: number; cost: number; duration: number }
  'supervisor:aborted': { reason: string; completedNodes: number; partialResult: boolean }

  // === Workspace meta events ===
  'workspace:mode_suggest': { mode: string; reason: string }
  'workspace:notification': { title: string; message: string; severity: 'info' | 'warning' | 'error' }

  // === Budget events ===
  'budget:warning': { source: string; pct: number; usedUsd: number; limitUsd: number }
  'budget:exceeded': { source: string; pct: number; usedUsd: number; limitUsd: number; isGlobal: boolean }

  // === Monitor substep events (enriched pipeline) ===
  'monitor:substep': {
    rootId: string
    nodeId: string
    substep: {
      id: string
      label: string
      status: 'active' | 'done' | 'skipped'
      order: number
      files?: string[]
    }
  }

  // === Progress narrative events ===
  'progress:narrative': {
    nodeId?: string
    narrative: string
    lang: string
    milestone?: {
      current: number
      total: number
      label: string
    }
  }

  // === Canvas agent interaction events ===
  'canvas:agent_draw': {
    action: 'draw' | 'update' | 'clear' | 'annotate' | 'highlight'
    shapes: Array<{
      type?: string
      id: string
      props: Record<string, unknown>
      position?: { x: number; y: number }
      connections?: string[]
    }>
    layout?: 'auto' | 'grid' | 'tree' | 'flow'
    viewport?: { x: number; y: number; zoom: number }
    intent?: string
    autoSwitch?: boolean
  }

  'canvas:user_feedback': {
    action: 'select' | 'delete' | 'annotate' | 'connect'
    shapeIds: string[]
    annotation?: string
    snapshot?: {
      shapeCount: number
      selectedTypes: string[]
    }
  }
}
