import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { TypedEventBus } from '../../core/event-bus.js'
import type { WorkspaceEventMap } from '../../dashboard/workspace-events.js'
import {
  handleMonitorRoute,
  MonitorActivityLog,
} from '../../dashboard/monitor-routes.js'
import type { GoalNodeId, GoalTree, GoalNode } from '../../goals/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkspaceBus() {
  return new TypedEventBus<WorkspaceEventMap>()
}

/** Minimal mock GoalTree */
function makeTree(overrides: Partial<GoalTree> & { nodes?: Map<GoalNodeId, GoalNode> } = {}): GoalTree {
  const rootId = ('root-1' as GoalNodeId)
  const nodeId = ('node-1' as GoalNodeId)
  const defaultNodes = new Map<GoalNodeId, GoalNode>([
    [rootId, {
      id: rootId,
      parentId: null,
      task: 'Root task',
      dependsOn: [],
      depth: 0,
      status: 'executing',
      createdAt: 1000,
      updatedAt: 2000,
    }],
    [nodeId, {
      id: nodeId,
      parentId: rootId,
      task: 'Child task',
      dependsOn: [],
      depth: 1,
      status: 'pending',
      createdAt: 1000,
      updatedAt: 2000,
      retryCount: 0,
    }],
  ])

  return {
    rootId,
    sessionId: 'sess-1',
    taskDescription: 'Test goal',
    nodes: overrides.nodes ?? defaultNodes,
    createdAt: 1000,
    ...overrides,
  }
}

/** Minimal mock GoalStorage */
function makeGoalStorage(trees: GoalTree[] = []) {
  return {
    getInterruptedTrees: vi.fn(() => trees),
    getTree: vi.fn((id: GoalNodeId) => trees.find((t) => t.rootId === id) ?? null),
  } as any
}

/** Build a fake IncomingMessage with optional JSON body */
function fakeReq(method: string, body?: Record<string, unknown>): IncomingMessage {
  const readable = new Readable({
    read() {
      if (body) {
        this.push(JSON.stringify(body))
      }
      this.push(null)
    },
  })
  ;(readable as any).method = method
  return readable as unknown as IncomingMessage
}

/** Build a fake ServerResponse that captures writeHead + end output */
function fakeRes(): ServerResponse & { _status: number; _body: string } {
  const chunks: Buffer[] = []
  let status = 0

  const writable = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk))
      cb()
    },
  }) as any

  writable._status = 0
  writable._body = ''
  writable.writeHead = (s: number, _headers?: Record<string, string>) => {
    status = s
    writable._status = s
  }
  writable.end = (data?: string | Buffer) => {
    if (data) chunks.push(Buffer.from(data))
    writable._body = Buffer.concat(chunks).toString()
    writable._status = status
  }

  return writable as ServerResponse & { _status: number; _body: string }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleMonitorRoute', () => {
  let activityLog: MonitorActivityLog
  let workspaceBus: TypedEventBus<WorkspaceEventMap>

  beforeEach(() => {
    activityLog = new MonitorActivityLog()
    workspaceBus = makeWorkspaceBus()
  })

  it('returns false for non-monitor routes', () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    const handled = handleMonitorRoute('/api/config', 'GET', req, res, undefined, undefined, activityLog)
    expect(handled).toBe(false)
  })

  it('GET /api/monitor/dag returns null when no goalStorage', () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    handleMonitorRoute('/api/monitor/dag', 'GET', req, res, undefined, undefined, activityLog)
    expect(res._status).toBe(200)
    expect(JSON.parse(res._body)).toEqual({ dag: null })
  })

  it('GET /api/monitor/dag returns null when no active trees', () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    const storage = makeGoalStorage([])
    handleMonitorRoute('/api/monitor/dag', 'GET', req, res, storage, undefined, activityLog)
    expect(res._status).toBe(200)
    expect(JSON.parse(res._body)).toEqual({ dag: null })
  })

  it('GET /api/monitor/dag returns serialized DAG for active tree', () => {
    const tree = makeTree()
    const storage = makeGoalStorage([tree])
    const req = fakeReq('GET')
    const res = fakeRes()
    handleMonitorRoute('/api/monitor/dag', 'GET', req, res, storage, undefined, activityLog)

    expect(res._status).toBe(200)
    const body = JSON.parse(res._body)
    expect(body.dag).not.toBeNull()
    expect(body.dag.rootId).toBe('root-1')
    expect(body.dag.nodes).toHaveLength(2)
    expect(body.dag.taskDescription).toBe('Test goal')
  })

  it('GET /api/monitor/tasks returns empty array when no goalStorage', () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    handleMonitorRoute('/api/monitor/tasks', 'GET', req, res, undefined, undefined, activityLog)
    expect(res._status).toBe(200)
    expect(JSON.parse(res._body)).toEqual({ tasks: [] })
  })

  it('GET /api/monitor/tasks returns task list (excluding root node)', () => {
    const tree = makeTree()
    const storage = makeGoalStorage([tree])
    const req = fakeReq('GET')
    const res = fakeRes()
    handleMonitorRoute('/api/monitor/tasks', 'GET', req, res, storage, undefined, activityLog)

    expect(res._status).toBe(200)
    const body = JSON.parse(res._body)
    expect(body.rootId).toBe('root-1')
    // Root node is excluded from tasks list
    expect(body.tasks).toHaveLength(1)
    expect(body.tasks[0].id).toBe('node-1')
  })

  it('GET /api/monitor/activity returns activity entries', () => {
    activityLog.push({ action: 'tool_execute', tool: 'read', detail: 'Reading file', timestamp: 1000 })
    activityLog.push({ action: 'tool_execute', tool: 'write', detail: 'Writing file', timestamp: 2000 })

    const req = fakeReq('GET')
    const res = fakeRes()
    handleMonitorRoute('/api/monitor/activity', 'GET', req, res, undefined, undefined, activityLog)

    expect(res._status).toBe(200)
    const body = JSON.parse(res._body)
    expect(body.entries).toHaveLength(2)
    expect(body.entries[0].tool).toBe('read')
    expect(body.entries[1].tool).toBe('write')
  })

  it('GET /api/monitor/activity respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      activityLog.push({ action: 'test', detail: `entry ${i}`, timestamp: i })
    }

    const req = fakeReq('GET')
    const res = fakeRes()
    handleMonitorRoute('/api/monitor/activity?limit=3', 'GET', req, res, undefined, undefined, activityLog)

    expect(res._status).toBe(200)
    const body = JSON.parse(res._body)
    expect(body.entries).toHaveLength(3)
  })

  it('POST /api/monitor/task/:id/approve emits gate_response', async () => {
    const received: unknown[] = []
    workspaceBus.on('monitor:gate_response' as any, (ev: unknown) => received.push(ev))

    const req = fakeReq('POST', { rootId: 'root-1' })
    const res = fakeRes()
    handleMonitorRoute('/api/monitor/task/node-1/approve', 'POST', req, res, undefined, workspaceBus, activityLog)

    // Wait for async readJsonBody to complete
    await new Promise((r) => setTimeout(r, 50))

    expect(res._status).toBe(200)
    expect(JSON.parse(res._body).status).toBe('approved')
    expect(received).toHaveLength(1)
    expect((received[0] as any).action).toBe('approve')
    expect((received[0] as any).nodeId).toBe('node-1')
  })

  it('POST /api/monitor/task/:id/skip emits gate_response with skip action', async () => {
    const received: unknown[] = []
    workspaceBus.on('monitor:gate_response' as any, (ev: unknown) => received.push(ev))

    const req = fakeReq('POST', { rootId: 'root-1' })
    const res = fakeRes()
    handleMonitorRoute('/api/monitor/task/node-2/skip', 'POST', req, res, undefined, workspaceBus, activityLog)

    await new Promise((r) => setTimeout(r, 50))

    expect(res._status).toBe(200)
    expect(JSON.parse(res._body).status).toBe('skipped')
    expect(received).toHaveLength(1)
    expect((received[0] as any).action).toBe('skip')
    expect((received[0] as any).nodeId).toBe('node-2')
  })

  it('POST /api/monitor/task/:id/approve returns 503 when no workspaceBus', () => {
    const req = fakeReq('POST', {})
    const res = fakeRes()
    handleMonitorRoute('/api/monitor/task/node-1/approve', 'POST', req, res, undefined, undefined, activityLog)

    expect(res._status).toBe(503)
    expect(JSON.parse(res._body).error).toBe('Workspace bus not available')
  })

  it('returns 404 for unknown /api/monitor/* path', () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    const handled = handleMonitorRoute('/api/monitor/unknown', 'GET', req, res, undefined, undefined, activityLog)

    expect(handled).toBe(true)
    expect(res._status).toBe(404)
  })
})

describe('MonitorActivityLog', () => {
  it('starts empty', () => {
    const log = new MonitorActivityLog()
    expect(log.size).toBe(0)
    expect(log.getRecent()).toEqual([])
  })

  it('pushes and retrieves entries', () => {
    const log = new MonitorActivityLog()
    log.push({ action: 'test', detail: 'entry 1', timestamp: 1 })
    log.push({ action: 'test', detail: 'entry 2', timestamp: 2 })

    expect(log.size).toBe(2)
    expect(log.getRecent()).toHaveLength(2)
  })

  it('caps at 100 entries', () => {
    const log = new MonitorActivityLog()
    for (let i = 0; i < 120; i++) {
      log.push({ action: 'test', detail: `entry ${i}`, timestamp: i })
    }
    expect(log.size).toBe(100)
    // Oldest entries should be evicted
    expect(log.getRecent(1)[0].detail).toBe('entry 119')
  })

  it('getRecent respects limit parameter', () => {
    const log = new MonitorActivityLog()
    for (let i = 0; i < 10; i++) {
      log.push({ action: 'test', detail: `entry ${i}`, timestamp: i })
    }
    const recent = log.getRecent(3)
    expect(recent).toHaveLength(3)
    expect(recent[0].detail).toBe('entry 7')
  })
})
