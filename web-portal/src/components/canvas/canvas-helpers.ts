import type { CanvasShape } from '../../stores/canvas-store'
import type { DagState, MonitorTask } from '../../stores/monitor-store'
import { getDefaultDimensions, type ResolvedShape, type CanvasConnection } from './canvas-types'

/* ── Grid snap ────────────────────────────────────────────────────── */

const GRID_SIZE = 20

export function snapToGrid(x: number, y: number, gridSize = GRID_SIZE): { x: number; y: number } {
  return {
    x: Math.round(x / gridSize) * gridSize,
    y: Math.round(y / gridSize) * gridSize,
  }
}

/* ── Formatting helpers ────────────────────────────────────────────── */

export function formatLastSync(value: number | null): string {
  if (!value) return 'Waiting'
  const diff = Date.now() - value
  if (diff < 60_000) return 'Just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}

export function formatSessionLabel(sessionId: string | null): string {
  if (!sessionId) return 'Transient'
  if (sessionId.length <= 16) return sessionId
  return `${sessionId.slice(0, 8)}...${sessionId.slice(-6)}`
}

/* ── Shape conversion ──────────────────────────────────────────────── */

const CASCADE_GAP_X = 40
const CASCADE_GAP_Y = 40

export function canvasShapeToResolved(raw: CanvasShape, placementIndex = 0): ResolvedShape {
  const dims = getDefaultDimensions(raw.type ?? 'note-block')
  const w = typeof raw.props?.w === 'number' ? raw.props.w as number : dims.w
  const h = typeof raw.props?.h === 'number' ? raw.props.h as number : dims.h

  let x = raw.position?.x ?? -1
  let y = raw.position?.y ?? -1

  if (x < 0 || y < 0) {
    const cols = 4
    const col = placementIndex % cols
    const row = Math.floor(placementIndex / cols)
    x = 80 + col * (w + CASCADE_GAP_X)
    y = 80 + row * (h + CASCADE_GAP_Y)
  }

  return {
    id: raw.id,
    type: raw.type ?? 'note-block',
    x,
    y,
    w,
    h,
    props: raw.props,
    source: raw.source,
  }
}

/* ── Monitor fallback DAG → shapes ─────────────────────────────────── */

function getTaskCardPriority(status: string): string {
  switch (status) {
    case 'failed':
    case 'blocked':
      return 'critical'
    case 'executing':
    case 'verifying':
      return 'high'
    case 'pending':
      return 'medium'
    default:
      return 'low'
  }
}

export function buildMonitorFallbackShapes(
  activeRootId: string | null,
  dag: DagState | null,
  tasks: Record<string, MonitorTask>,
): ResolvedShape[] {
  if (!activeRootId) return []
  const scopedTasks = Object.values(tasks).filter((t) => t.rootId === activeRootId)
  if (scopedTasks.length === 0) return []

  const taskIds = new Set(scopedTasks.map((t) => t.id))
  const incoming = new Map<string, Set<string>>()
  const outgoing = new Map<string, Set<string>>()
  for (const t of scopedTasks) {
    incoming.set(t.id, new Set())
    outgoing.set(t.id, new Set())
  }
  for (const edge of dag?.edges ?? []) {
    if (!taskIds.has(edge.source) || !taskIds.has(edge.target)) continue
    incoming.get(edge.target)?.add(edge.source)
    outgoing.get(edge.source)?.add(edge.target)
  }

  const queue = scopedTasks
    .filter((t) => (incoming.get(t.id)?.size ?? 0) === 0)
    .map((t) => t.id)
  const depth = new Map<string, number>(queue.map((id) => [id, 0]))
  while (queue.length > 0) {
    const cur = queue.shift()!
    const curD = depth.get(cur) ?? 0
    for (const child of outgoing.get(cur) ?? []) {
      const next = curD + 1
      if ((depth.get(child) ?? -1) >= next) continue
      depth.set(child, next)
      queue.push(child)
    }
  }

  const tasksByDepth = new Map<number, MonitorTask[]>()
  for (const t of scopedTasks) {
    const d = depth.get(t.id) ?? 0
    const bucket = tasksByDepth.get(d) ?? []
    bucket.push(t)
    tasksByDepth.set(d, bucket)
  }

  const statusCounts = scopedTasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1
    return acc
  }, {})

  const shapes: ResolvedShape[] = [
    {
      id: `goal-summary-${activeRootId}`,
      type: 'goal-summary',
      x: 80,
      y: 120,
      w: 340,
      h: 200,
      source: 'agent',
      props: {
        title: `Goal ${activeRootId.slice(0, 8)}`,
        taskCount: scopedTasks.length,
        completedCount: statusCounts.completed ?? 0,
        failedCount: statusCounts.failed ?? 0,
        executingCount: statusCounts.executing ?? 0,
        skippedCount: statusCounts.skipped ?? 0,
      },
    },
  ]

  const colGap = 260
  const rowGap = 150
  for (const [d, bucket] of [...tasksByDepth.entries()].sort((a, b) => a[0] - b[0])) {
    bucket
      .sort((a, b) => a.title.localeCompare(b.title))
      .forEach((task, i) => {
        shapes.push({
          id: `goal-task-${task.id}`,
          type: 'task-card',
          x: 480 + d * colGap,
          y: 140 + i * rowGap,
          w: 240,
          h: 130,
          source: 'agent',
          props: {
            title: task.title,
            status: task.status,
            priority: getTaskCardPriority(task.status),
          },
        })
      })
  }

  return shapes
}

/** Build CanvasConnection[] from DAG edges matched against shape IDs */
export function buildFallbackConnections(
  dag: DagState | null,
  shapeIds: Set<string>,
): CanvasConnection[] {
  const conns: CanvasConnection[] = []
  for (const edge of dag?.edges ?? []) {
    const fromId = `goal-task-${edge.source}`
    const toId = `goal-task-${edge.target}`
    if (shapeIds.has(fromId) && shapeIds.has(toId)) {
      conns.push({ id: `conn-${edge.source}-${edge.target}`, from: fromId, to: toId })
    }
  }
  return conns
}
