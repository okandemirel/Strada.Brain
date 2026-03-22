/**
 * Monitor REST Endpoints
 *
 * Provides REST API endpoints for the workspace monitor panel:
 *   GET  /api/monitor/dag          — current DAG state (active goal tree)
 *   GET  /api/monitor/tasks        — task list with status + reviewStatus
 *   GET  /api/monitor/task/:id     — single task detail
 *   GET  /api/monitor/activity     — last N activity entries
 *   POST /api/monitor/task/:id/approve — approve a gate request
 *   POST /api/monitor/task/:id/skip    — skip a task
 *
 * Follows the inline route-matching pattern used by DashboardServer.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GoalStorage } from '../goals/index.js'
import type { GoalTree, GoalNodeId } from '../goals/types.js'
import type { WorkspaceBus } from './workspace-bus.js'
import { calculateProgress } from '../goals/goal-progress.js'

// =============================================================================
// ACTIVITY RING BUFFER
// =============================================================================

export interface MonitorActivityEntry {
  taskId?: string
  action: string
  tool?: string
  detail: string
  timestamp: number
}

const MAX_ACTIVITY_ENTRIES = 100

/**
 * In-memory ring buffer for monitor activity entries.
 * Subscribes to workspace bus 'monitor:agent_activity' events.
 */
export class MonitorActivityLog {
  private readonly entries: MonitorActivityEntry[] = []

  push(entry: MonitorActivityEntry): void {
    this.entries.push(entry)
    if (this.entries.length > MAX_ACTIVITY_ENTRIES) {
      this.entries.shift()
    }
  }

  getRecent(limit: number = 50): MonitorActivityEntry[] {
    const safeLimit = Math.max(1, Math.min(limit, MAX_ACTIVITY_ENTRIES))
    return this.entries.slice(-safeLimit)
  }

  get size(): number {
    return this.entries.length
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readJsonBody<T>(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes = 4096,
): Promise<T | null> {
  return new Promise((resolve) => {
    let body = ''
    let bodyBytes = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      bodyBytes += chunk.length
      if (bodyBytes > maxBytes) {
        aborted = true
        req.destroy()
        jsonResponse(res, 413, { error: 'Request body too large' })
        resolve(null)
        return
      }
      body += chunk.toString()
    })
    req.on('end', () => {
      if (aborted) return
      try {
        resolve(JSON.parse(body || '{}') as T)
      } catch {
        jsonResponse(res, 400, { error: 'Invalid JSON body' })
        resolve(null)
      }
    })
  })
}

/** Serialize a GoalTree into a DAG structure for the monitor panel. */
function serializeDag(tree: GoalTree): {
  rootId: string
  taskDescription: string
  progress: { completed: number; total: number; percentage: number }
  nodes: Array<{
    id: string; task: string; status: string; depth: number
    dependsOn: string[]; parentId: string | null
    startedAt: number | null; completedAt: number | null
    retryCount: number
  }>
  edges: Array<{ source: string; target: string }>
} {
  const nodes: Array<{
    id: string; task: string; status: string; depth: number
    dependsOn: string[]; parentId: string | null
    startedAt: number | null; completedAt: number | null
    retryCount: number
  }> = []
  const edges: Array<{ source: string; target: string }> = []

  for (const [, node] of tree.nodes) {
    nodes.push({
      id: node.id,
      task: node.task,
      status: node.status,
      depth: node.depth,
      dependsOn: [...node.dependsOn],
      parentId: node.parentId,
      startedAt: node.startedAt ?? null,
      completedAt: node.completedAt ?? null,
      retryCount: node.retryCount ?? 0,
    })
    for (const dep of node.dependsOn) {
      edges.push({ source: dep, target: node.id })
    }
  }

  const progress = calculateProgress(tree)

  return {
    rootId: tree.rootId,
    taskDescription: tree.taskDescription,
    progress,
    nodes,
    edges,
  }
}

/** Serialize a single node for the task detail endpoint. */
function serializeTaskDetail(tree: GoalTree, nodeId: string): Record<string, unknown> | null {
  const node = tree.nodes.get(nodeId as GoalNodeId)
  if (!node) return null

  return {
    id: node.id,
    task: node.task,
    status: node.status,
    depth: node.depth,
    dependsOn: [...node.dependsOn],
    parentId: node.parentId,
    result: node.result ?? null,
    error: node.error ?? null,
    startedAt: node.startedAt ?? null,
    completedAt: node.completedAt ?? null,
    retryCount: node.retryCount ?? 0,
    redecompositionCount: node.redecompositionCount ?? 0,
  }
}

// =============================================================================
// ROUTE HANDLER
// =============================================================================

/**
 * Handle /api/monitor/* requests.
 * Returns true if the request was handled, false if it should fall through.
 */
export function handleMonitorRoute(
  url: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  goalStorage: GoalStorage | undefined,
  workspaceBus: WorkspaceBus | undefined,
  activityLog: MonitorActivityLog,
): boolean {
  if (!url.startsWith('/api/monitor')) return false

  // ── GET /api/monitor/dag ──────────────────────────────────────────────
  if (method === 'GET' && (url === '/api/monitor/dag' || url.startsWith('/api/monitor/dag?'))) {
    if (!goalStorage) {
      jsonResponse(res, 200, { dag: null })
      return true
    }
    try {
      // Find the most recent active (executing) goal tree
      const activeTrees = goalStorage.getInterruptedTrees()
      if (activeTrees.length === 0) {
        jsonResponse(res, 200, { dag: null })
        return true
      }
      const tree = activeTrees[0]!
      jsonResponse(res, 200, { dag: serializeDag(tree) })
    } catch {
      jsonResponse(res, 200, { dag: null })
    }
    return true
  }

  // ── GET /api/monitor/tasks ────────────────────────────────────────────
  if (method === 'GET' && (url === '/api/monitor/tasks' || url.startsWith('/api/monitor/tasks?'))) {
    if (!goalStorage) {
      jsonResponse(res, 200, { tasks: [] })
      return true
    }
    try {
      const params = new URL(url, 'http://localhost').searchParams
      const rootId = params.get('rootId')

      let tree: GoalTree | null = null
      if (rootId) {
        tree = goalStorage.getTree(rootId as GoalNodeId)
      } else {
        // Default: most recent active tree
        const activeTrees = goalStorage.getInterruptedTrees()
        tree = activeTrees.length > 0 ? activeTrees[0]! : null
      }

      if (!tree) {
        jsonResponse(res, 200, { tasks: [] })
        return true
      }

      const tasks: Array<Record<string, unknown>> = []
      for (const [id, node] of tree.nodes) {
        if (id === tree.rootId) continue // skip root meta-node
        tasks.push({
          id: node.id,
          task: node.task,
          status: node.status,
          depth: node.depth,
          dependsOn: [...node.dependsOn],
          parentId: node.parentId,
          startedAt: node.startedAt ?? null,
          completedAt: node.completedAt ?? null,
          retryCount: node.retryCount ?? 0,
        })
      }
      jsonResponse(res, 200, { rootId: tree.rootId, tasks })
    } catch {
      jsonResponse(res, 200, { tasks: [] })
    }
    return true
  }

  // ── GET /api/monitor/task/:id ─────────────────────────────────────────
  const taskDetailMatch = url.match(/^\/api\/monitor\/task\/([^/?]+)$/)
  if (method === 'GET' && taskDetailMatch) {
    const taskId = decodeURIComponent(taskDetailMatch[1]!)
    if (!goalStorage) {
      jsonResponse(res, 404, { error: 'Goal storage not available' })
      return true
    }
    try {
      // Search across active trees for the node
      const activeTrees = goalStorage.getInterruptedTrees()
      for (const tree of activeTrees) {
        const detail = serializeTaskDetail(tree, taskId)
        if (detail) {
          jsonResponse(res, 200, { task: detail, rootId: tree.rootId })
          return true
        }
      }
      jsonResponse(res, 404, { error: 'Task not found' })
    } catch {
      jsonResponse(res, 500, { error: 'Failed to retrieve task' })
    }
    return true
  }

  // ── GET /api/monitor/activity ─────────────────────────────────────────
  if (method === 'GET' && (url === '/api/monitor/activity' || url.startsWith('/api/monitor/activity?'))) {
    const params = new URL(url, 'http://localhost').searchParams
    const limitParam = params.get('limit')
    const limit = limitParam ? Math.max(1, Math.min(parseInt(limitParam, 10) || 50, MAX_ACTIVITY_ENTRIES)) : 50
    jsonResponse(res, 200, { entries: activityLog.getRecent(limit) })
    return true
  }

  // ── POST /api/monitor/task/:id/approve ────────────────────────────────
  const approveMatch = url.match(/^\/api\/monitor\/task\/([^/?]+)\/approve$/)
  if (method === 'POST' && approveMatch) {
    const taskId = decodeURIComponent(approveMatch[1]!)
    if (!workspaceBus) {
      jsonResponse(res, 503, { error: 'Workspace bus not available' })
      return true
    }
    void readJsonBody<{ rootId?: string }>(req, res).then((parsed) => {
      if (!parsed) return
      workspaceBus.emit('monitor:gate_response' as any, {
        nodeId: taskId,
        rootId: parsed.rootId ?? '',
        action: 'approve',
        source: 'dashboard',
        timestamp: Date.now(),
      })
      jsonResponse(res, 200, { status: 'approved', taskId })
    })
    return true
  }

  // ── POST /api/monitor/task/:id/skip ───────────────────────────────────
  const skipMatch = url.match(/^\/api\/monitor\/task\/([^/?]+)\/skip$/)
  if (method === 'POST' && skipMatch) {
    const taskId = decodeURIComponent(skipMatch[1]!)
    if (!workspaceBus) {
      jsonResponse(res, 503, { error: 'Workspace bus not available' })
      return true
    }
    void readJsonBody<{ rootId?: string }>(req, res).then((parsed) => {
      if (!parsed) return
      workspaceBus.emit('monitor:gate_response' as any, {
        nodeId: taskId,
        rootId: parsed.rootId ?? '',
        action: 'skip',
        source: 'dashboard',
        timestamp: Date.now(),
      })
      jsonResponse(res, 200, { status: 'skipped', taskId })
    })
    return true
  }

  // No match within /api/monitor namespace
  jsonResponse(res, 404, { error: 'Monitor endpoint not found' })
  return true
}
