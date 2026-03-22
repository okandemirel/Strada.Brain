export interface WorkspaceEventMap {
  [key: string]: unknown
  // === Monitor events (Phase 3 — full payloads) ===
  'monitor:dag_init': {
    rootId: string
    nodes: Array<{ id: string; task: string; status: string; reviewStatus: string; depth: number; dependsOn: string[] }>
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
    nodes: Array<{ id: string; task: string; status: string; reviewStatus: string; depth: number; dependsOn: string[] }>
    edges: Array<{ source: string; target: string }>
  }

  // === Canvas events (Phase 4 — stub payloads) ===
  'canvas:shapes_add': unknown
  'canvas:shapes_update': unknown
  'canvas:shapes_remove': unknown
  'canvas:viewport': unknown
  'canvas:arrange': unknown

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
