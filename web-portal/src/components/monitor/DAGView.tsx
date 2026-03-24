import { useMemo } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useMonitorStore } from '../../stores/monitor-store'
import { TaskNode, ReviewNode, GateNode } from './dag-nodes'
import { TypingAnimation } from '../ui/typing-animation'

const nodeTypes = { task: TaskNode, review: ReviewNode, gate: GateNode }

/* ------------------------------------------------------------------ */
/*  Simple auto-layout: topological sort + layering                    */
/* ------------------------------------------------------------------ */

function layoutNodes(
  rawNodes: Array<{ id: string; [key: string]: unknown }>,
  rawEdges: Array<{ source: string; target: string }>,
): Node[] {
  const NODE_W = 200
  const NODE_H = 80
  const GAP_X = 60
  const GAP_Y = 100

  // Build adjacency + in-degree
  const inDegree = new Map<string, number>()
  const children = new Map<string, string[]>()
  for (const n of rawNodes) {
    inDegree.set(n.id, 0)
    children.set(n.id, [])
  }
  for (const e of rawEdges) {
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1)
    children.get(e.source)?.push(e.target)
  }

  // Kahn's algorithm -> layers
  const layers: string[][] = []
  let queue = rawNodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id)
  const visited = new Set<string>()

  while (queue.length > 0) {
    layers.push(queue)
    const next: string[] = []
    for (const id of queue) {
      visited.add(id)
      for (const child of children.get(id) ?? []) {
        const deg = (inDegree.get(child) ?? 1) - 1
        inDegree.set(child, deg)
        if (deg === 0 && !visited.has(child)) next.push(child)
      }
    }
    queue = next
  }

  // Place orphans (cycles or disconnected) in last layer
  for (const n of rawNodes) {
    if (!visited.has(n.id)) {
      if (layers.length === 0) layers.push([])
      layers[layers.length - 1].push(n.id)
    }
  }

  // Position
  const posMap = new Map<string, { x: number; y: number }>()
  for (let row = 0; row < layers.length; row++) {
    const layer = layers[row]
    const totalWidth = layer.length * NODE_W + (layer.length - 1) * GAP_X
    const startX = -totalWidth / 2
    for (let col = 0; col < layer.length; col++) {
      posMap.set(layer[col], {
        x: startX + col * (NODE_W + GAP_X),
        y: row * (NODE_H + GAP_Y),
      })
    }
  }

  return rawNodes.map((n) => ({
    id: n.id,
    type: (n.nodeType as string) || 'task',
    position: posMap.get(n.id) ?? { x: 0, y: 0 },
    data: {
      label: (n.task as string) || n.id,
      status: (n.status as string) || 'pending',
      reviewStatus: (n.reviewStatus as string) || undefined,
      reviewType: (n.reviewType as string) || undefined,
    },
  }))
}

/* ------------------------------------------------------------------ */
/*  DAGView component                                                  */
/* ------------------------------------------------------------------ */

export default function DAGView() {
  const dag = useMonitorStore((s) => s.dag)
  const setSelectedTask = useMonitorStore((s) => s.setSelectedTask)

  const { nodes, edges } = useMemo(() => {
    if (!dag) return { nodes: [], edges: [] }

    const nodes = layoutNodes(dag.nodes, dag.edges)

    const executingIds = new Set(
      dag.nodes.filter((n) => (n.status as string) === 'executing').map((n) => n.id),
    )
    const edges: Edge[] = dag.edges.map((e, i) => ({
      id: `e-${i}`,
      source: e.source,
      target: e.target,
      animated: executingIds.has(e.source) || executingIds.has(e.target),
      style: { stroke: 'var(--color-border)' },
    }))

    return { nodes, edges }
  }, [dag])

  if (!dag) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-text-tertiary">
        <svg
          className="w-12 h-12 text-accent/30"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1}
        >
          <circle cx="12" cy="5" r="2" />
          <circle cx="5" cy="19" r="2" />
          <circle cx="19" cy="19" r="2" />
          <line x1="12" y1="7" x2="5" y2="17" strokeLinecap="round" />
          <line x1="12" y1="7" x2="19" y2="17" strokeLinecap="round" />
        </svg>
        <TypingAnimation
          className="text-sm text-text-tertiary"
          words={[
            'No active goal. Start a task to see the DAG.',
            'Waiting for goal decomposition...',
            'Send a complex task to trigger planning.',
          ]}
          duration={40}
          deleteSpeed={20}
          pauseDelay={2500}
          loop
          showCursor
          cursorStyle="line"
        />
      </div>
    )
  }

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => setSelectedTask(node.id)}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--color-border-subtle)" gap={20} />
        <Controls
          className="!bg-surface !border-border !shadow-lg [&>button]:!bg-surface [&>button]:!border-border [&>button]:!fill-text-secondary [&>button:hover]:!bg-white/10"
        />
      </ReactFlow>
    </div>
  )
}
