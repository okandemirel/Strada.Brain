import { useMemo } from 'react'
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useMonitorStore } from '../../stores/monitor-store'
import { GateNode, ReviewNode, TaskNode } from './dag-nodes'
import { TypingAnimation } from '../ui/typing-animation'

const nodeTypes = { task: TaskNode, review: ReviewNode, gate: GateNode }

function layoutNodes(
  rawNodes: Array<{ id: string; [key: string]: unknown }>,
  rawEdges: Array<{ source: string; target: string }>,
): Node[] {
  const NODE_W = 200
  const NODE_H = 80
  const GAP_X = 60
  const GAP_Y = 100

  const inDegree = new Map<string, number>()
  const children = new Map<string, string[]>()

  for (const node of rawNodes) {
    inDegree.set(node.id, 0)
    children.set(node.id, [])
  }

  for (const edge of rawEdges) {
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
    children.get(edge.source)?.push(edge.target)
  }

  const layers: string[][] = []
  let queue = rawNodes.filter((node) => (inDegree.get(node.id) ?? 0) === 0).map((node) => node.id)
  const visited = new Set<string>()

  while (queue.length > 0) {
    layers.push(queue)
    const next: string[] = []

    for (const id of queue) {
      visited.add(id)
      for (const child of children.get(id) ?? []) {
        const degree = (inDegree.get(child) ?? 1) - 1
        inDegree.set(child, degree)
        if (degree === 0 && !visited.has(child)) next.push(child)
      }
    }

    queue = next
  }

  for (const node of rawNodes) {
    if (!visited.has(node.id)) {
      if (layers.length === 0) layers.push([])
      layers[layers.length - 1].push(node.id)
    }
  }

  const positions = new Map<string, { x: number; y: number }>()

  for (let row = 0; row < layers.length; row++) {
    const layer = layers[row]
    const totalWidth = layer.length * NODE_W + (layer.length - 1) * GAP_X
    const startX = -totalWidth / 2

    for (let column = 0; column < layer.length; column++) {
      positions.set(layer[column], {
        x: startX + column * (NODE_W + GAP_X),
        y: row * (NODE_H + GAP_Y),
      })
    }
  }

  return rawNodes.map((node) => ({
    id: node.id,
    type: (node.nodeType as string) || 'task',
    position: positions.get(node.id) ?? { x: 0, y: 0 },
    data: {
      label: (node.task as string) || node.id,
      status: (node.status as string) || 'pending',
      reviewStatus: (node.reviewStatus as string) || undefined,
      reviewType: (node.reviewType as string) || undefined,
    },
  }))
}

export default function DAGView() {
  const dag = useMonitorStore((s) => s.dag)
  const setSelectedTask = useMonitorStore((s) => s.setSelectedTask)

  const { nodes, edges } = useMemo(() => {
    if (!dag) return { nodes: [], edges: [] }

    const nodes = layoutNodes(dag.nodes, dag.edges)
    const executingIds = new Set(
      dag.nodes.filter((node) => (node.status as string) === 'executing').map((node) => node.id),
    )

    const edges: Edge[] = dag.edges.map((edge, index) => ({
      id: `e-${index}`,
      source: edge.source,
      target: edge.target,
      animated: executingIds.has(edge.source) || executingIds.has(edge.target),
      style: { stroke: 'var(--color-border)', strokeWidth: 1.5 },
    }))

    return { nodes, edges }
  }, [dag])

  if (!dag) {
    return (
      <div className="h-full p-3">
        <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-6">
          <div className="max-w-xl text-center">
            <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-accent/75">
              DAG Workspace
            </div>
            <div className="mt-2 text-2xl font-semibold text-text">
              No active goal. Start a task to see the DAG.
            </div>
            <TypingAnimation
              className="mt-3 text-sm leading-6 text-text-secondary"
              words={[
                'Parallel branches and review gates will appear here.',
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
        </div>
      </div>
    )
  }

  return (
    <div className="h-full p-3">
      <div className="h-full overflow-hidden rounded-2xl border border-white/8 bg-black/10">
        <ReactFlow
          className="bg-transparent"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => setSelectedTask(node.id)}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="var(--color-border-subtle)" gap={24} />
          <Controls
            className="!rounded-xl !border-white/10 !bg-bg/90 !shadow-lg [&>button]:!border-white/10 [&>button]:!bg-bg/90 [&>button]:!fill-text-secondary [&>button:hover]:!bg-white/10"
          />
        </ReactFlow>
      </div>
    </div>
  )
}
