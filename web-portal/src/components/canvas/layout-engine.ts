import dagre from '@dagrejs/dagre'
import type { Node, Edge } from '@xyflow/react'
import type { CanvasShape } from '../../stores/canvas-store'
import type { DagState, MonitorTask } from '../../stores/monitor-store'
import { getDefaultDimensions, type ResolvedShape, type CanvasConnection } from './canvas-types'

type LayoutMode = 'flow' | 'kanban' | 'freeform'

const RANK_SEP = 200
const NODE_SEP = 80
const KANBAN_COL_WIDTH = 300
const KANBAN_ROW_HEIGHT = 160
const GRID_GAP = 40

const KANBAN_COLUMNS = ['planned', 'pending', 'executing', 'verifying', 'completed', 'failed'] as const

function nodeWidth(node: Node): number {
  return (node.style?.width as number) ?? 240
}
function nodeHeight(node: Node): number {
  return (node.style?.height as number) ?? 130
}

function applyDagreLayout(nodes: Node[], edges: Edge[], direction: 'LR' | 'TB'): Node[] {
  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: direction, ranksep: RANK_SEP, nodesep: NODE_SEP })

  for (const node of nodes) {
    g.setNode(node.id, { width: nodeWidth(node), height: nodeHeight(node) })
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  return nodes.map((node) => {
    const pos = g.node(node.id)
    return {
      ...node,
      position: {
        x: pos.x - nodeWidth(node) / 2,
        y: pos.y - nodeHeight(node) / 2,
      },
    }
  })
}

function applyKanbanLayout(nodes: Node[]): Node[] {
  const columns = new Map<string, Node[]>()

  for (const node of nodes) {
    const status = String((node.data as Record<string, unknown>)?.props !== undefined
      ? ((node.data as Record<string, Record<string, unknown>>).props?.status ?? 'pending')
      : 'pending')
    const col = KANBAN_COLUMNS.includes(status as typeof KANBAN_COLUMNS[number]) ? status : 'pending'
    if (!columns.has(col)) columns.set(col, [])
    columns.get(col)!.push(node)
  }

  const result: Node[] = []
  let colIndex = 0
  for (const colName of KANBAN_COLUMNS) {
    const colNodes = columns.get(colName)
    if (!colNodes?.length) continue
    for (let row = 0; row < colNodes.length; row++) {
      result.push({
        ...colNodes[row]!,
        position: { x: 80 + colIndex * KANBAN_COL_WIDTH, y: 80 + row * KANBAN_ROW_HEIGHT },
      })
    }
    colIndex++
  }

  const placed = new Set(result.map((n) => n.id))
  const nonTask = nodes.filter((n) => !placed.has(n.id))
  for (let row = 0; row < nonTask.length; row++) {
    result.push({
      ...nonTask[row]!,
      position: { x: 80 + colIndex * KANBAN_COL_WIDTH, y: 80 + row * KANBAN_ROW_HEIGHT },
    })
  }

  return result
}

function applyFreeformLayout(nodes: Node[]): Node[] {
  const occupied = new Set<string>()
  const result: Node[] = []

  for (const node of nodes) {
    const key = `${node.position.x},${node.position.y}`
    if (!occupied.has(key)) {
      occupied.add(key)
      result.push(node)
      continue
    }
    const w = nodeWidth(node)
    const h = nodeHeight(node)
    let placed = false
    for (let attempt = 0; attempt < 100; attempt++) {
      const col = attempt % 4
      const row = Math.floor(attempt / 4)
      const nx = 80 + col * (w + GRID_GAP)
      const ny = 80 + row * (h + GRID_GAP)
      const nKey = `${nx},${ny}`
      if (!occupied.has(nKey)) {
        occupied.add(nKey)
        result.push({ ...node, position: { x: nx, y: ny } })
        placed = true
        break
      }
    }
    if (!placed) result.push(node)
  }

  return result
}

export function applyLayout(
  nodes: Node[],
  edges: Edge[],
  mode: LayoutMode,
  options?: { direction?: 'LR' | 'TB' },
): { nodes: Node[]; edges: Edge[] } {
  if (nodes.length === 0) return { nodes, edges }

  switch (mode) {
    case 'flow':
      return { nodes: applyDagreLayout(nodes, edges, options?.direction ?? 'LR'), edges }
    case 'kanban':
      return { nodes: applyKanbanLayout(nodes), edges }
    case 'freeform':
      return { nodes: applyFreeformLayout(nodes), edges }
    default:
      return { nodes, edges }
  }
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
