import dagre from '@dagrejs/dagre'
import type { Node, Edge } from '@xyflow/react'

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
