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
  const activeRootId = useMonitorStore((s) => s.activeRootId)

  const { nodes, edges, summary } = useMemo(() => {
    if (!dag) {
      return {
        nodes: [],
        edges: [],
        summary: { total: 0, running: 0, completed: 0, reviewQueue: 0 },
      }
    }

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

    const total = dag.nodes.length
    const running = dag.nodes.filter((n) => (n.status as string) === 'executing').length
    const completed = dag.nodes.filter((n) => (n.status as string) === 'completed').length
    const reviewQueue = dag.nodes.filter((n) =>
      ['spec_review', 'quality_review', 'review_stuck'].includes((n.reviewStatus as string) ?? 'none'),
    ).length

    return {
      nodes,
      edges,
      summary: { total, running, completed, reviewQueue },
    }
  }, [dag])

  if (!dag) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="w-full max-w-3xl rounded-[28px] border border-white/8 bg-[radial-gradient(circle_at_top_left,rgba(0,229,255,0.14),transparent_26%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] p-6 shadow-[0_28px_120px_rgba(0,0,0,0.22)]">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-accent/80">
                DAG Workspace
              </div>
              <div className="mt-2 text-2xl font-semibold text-text">
                No active goal. Start a task to see the DAG.
              </div>
              <TypingAnimation
                className="mt-3 text-sm leading-6 text-text-secondary"
                words={[
                  'Waiting for goal decomposition...',
                  'Send a complex task to trigger planning.',
                  'Parallel branches and review gates will appear here.',
                ]}
                duration={40}
                deleteSpeed={20}
                pauseDelay={2500}
                loop
                showCursor
                cursorStyle="line"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
              {[
                ['Parallel layout', 'Branches, dependencies, and gates stay visible in one flow.'],
                ['Agent context', 'Node selection opens ownership, timing, and review detail.'],
                ['Live execution', 'Edges animate while tasks are executing or awaiting review.'],
              ].map(([title, description]) => (
                <div
                  key={title}
                  className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3"
                >
                  <div className="text-sm font-medium text-text">{title}</div>
                  <div className="mt-1 text-xs leading-5 text-text-secondary">{description}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-full w-full">
      <div className="pointer-events-none absolute left-4 right-4 top-4 z-10 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[260px] max-w-[420px] rounded-2xl border border-white/8 bg-bg/80 px-4 py-3 backdrop-blur-xl shadow-[0_20px_60px_rgba(0,0,0,0.2)]">
          <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-accent/80">
            Flow State
          </div>
          <div className="mt-1 text-sm font-medium text-text">
            Goal {activeRootId ? activeRootId : 'active'}
          </div>
          <div className="mt-1 text-xs leading-5 text-text-secondary">
            {summary.running > 0
              ? `${summary.running} nodes are executing now.`
              : 'Select a node to inspect the current execution branch.'}
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          {[
            ['Running', `${summary.running}`, 'text-accent'],
            ['Review', `${summary.reviewQueue}`, 'text-amber-300'],
            ['Done', `${summary.completed}/${summary.total}`, 'text-emerald-300'],
          ].map(([label, value, tone]) => (
            <div
              key={label}
              className="min-w-[100px] rounded-2xl border border-white/8 bg-bg/80 px-3 py-2 text-right backdrop-blur-xl shadow-[0_18px_50px_rgba(0,0,0,0.18)]"
            >
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">
                {label}
              </div>
              <div className={`mt-1 text-lg font-semibold ${tone}`}>{value}</div>
            </div>
          ))}
        </div>
      </div>

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
