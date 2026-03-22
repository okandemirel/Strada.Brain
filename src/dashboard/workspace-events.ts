export interface DagNodeShape {
  id: string
  task: string
  status: string
  reviewStatus: string
  depth: number
  dependsOn: string[]
}

export interface WorkspaceEventMap {
  [key: string]: unknown
  // === Monitor events (Phase 3 — full payloads) ===
  'monitor:dag_init': {
    rootId: string
    nodes: DagNodeShape[]
    edges: Array<{ source: string; target: string }>
  }
  'monitor:task_update': {
    rootId: string
    nodeId: string
    status: string
    reviewStatus?: string
    agentId?: string
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

  // === Code events (Phase 5 — stub payloads) ===
  'code:file_open': unknown
  'code:file_update': unknown
  'code:terminal_output': unknown
  'code:terminal_clear': unknown
  'code:annotation_add': unknown
  'code:annotation_clear': unknown

  // === Workspace meta events ===
  'workspace:mode_suggest': { mode: string; reason: string }
  'workspace:notification': { title: string; message: string; severity: 'info' | 'warning' | 'error' }
}
