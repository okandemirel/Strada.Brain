import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// Mock monitor store
let mockDag: unknown = null
const mockSetSelectedTask = vi.fn()

vi.mock('../../stores/monitor-store', () => ({
  useMonitorStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      dag: mockDag,
      setSelectedTask: mockSetSelectedTask,
    }
    return selector ? selector(state) : state
  },
}))

// Mock ReactFlow (requires canvas/SVG not available in jsdom)
interface MockNode { id: string; data?: { label?: string }; [key: string]: unknown }

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes, edges, onNodeClick, children }: { nodes: MockNode[]; edges: unknown[]; onNodeClick?: (event: null, node: MockNode) => void; children?: React.ReactNode }) => (
    <div data-testid="reactflow">
      <span data-testid="node-count">{nodes.length}</span>
      <span data-testid="edge-count">{edges.length}</span>
      {nodes.map((n: MockNode) => (
        <div
          key={n.id}
          data-testid={`node-${n.id}`}
          onClick={() => onNodeClick?.(null, n)}
        >
          {n.data?.label}
        </div>
      ))}
      {children}
    </div>
  ),
  Background: () => <div data-testid="background" />,
  Controls: () => <div data-testid="controls" />,
}))

// Mock dag-nodes (they also use @xyflow/react internals)
vi.mock('./dag-nodes', () => ({
  TaskNode: ({ data }: { data?: { label?: string } }) => <div>{data?.label}</div>,
  ReviewNode: ({ data }: { data?: { label?: string } }) => <div>{data?.label}</div>,
  GateNode: ({ data }: { data?: { label?: string } }) => <div>{data?.label}</div>,
}))

import DAGView from './DAGView'

describe('DAGView', () => {
  beforeEach(() => {
    mockDag = null
    mockSetSelectedTask.mockClear()
  })

  it('shows empty state when no DAG', () => {
    render(<DAGView />)
    expect(screen.getByText(/No active goal/)).toBeInTheDocument()
  })

  it('does not render ReactFlow when no DAG', () => {
    render(<DAGView />)
    expect(screen.queryByTestId('reactflow')).not.toBeInTheDocument()
  })

  it('renders ReactFlow when DAG exists', () => {
    mockDag = {
      nodes: [
        { id: 'n1', task: 'Task 1', status: 'pending', depth: 0, dependsOn: [] },
        { id: 'n2', task: 'Task 2', status: 'executing', depth: 1, dependsOn: ['n1'] },
      ],
      edges: [{ source: 'n1', target: 'n2' }],
    }
    render(<DAGView />)
    expect(screen.getByTestId('reactflow')).toBeInTheDocument()
  })

  it('creates correct number of nodes and edges', () => {
    mockDag = {
      nodes: [
        { id: 'n1', task: 'Task 1', status: 'pending', depth: 0, dependsOn: [] },
        { id: 'n2', task: 'Task 2', status: 'executing', depth: 1, dependsOn: ['n1'] },
        { id: 'n3', task: 'Task 3', status: 'pending', depth: 1, dependsOn: ['n1'] },
      ],
      edges: [
        { source: 'n1', target: 'n2' },
        { source: 'n1', target: 'n3' },
      ],
    }
    render(<DAGView />)
    expect(screen.getByTestId('node-count').textContent).toBe('3')
    expect(screen.getByTestId('edge-count').textContent).toBe('2')
  })

  it('renders node labels from task field', () => {
    mockDag = {
      nodes: [
        { id: 'n1', task: 'Build frontend', status: 'pending', depth: 0, dependsOn: [] },
      ],
      edges: [],
    }
    render(<DAGView />)
    expect(screen.getByText('Build frontend')).toBeInTheDocument()
  })

  it('node click calls setSelectedTask with node id', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()

    mockDag = {
      nodes: [
        { id: 'n1', task: 'Click me', status: 'pending', depth: 0, dependsOn: [] },
      ],
      edges: [],
    }
    render(<DAGView />)
    await user.click(screen.getByTestId('node-n1'))
    expect(mockSetSelectedTask).toHaveBeenCalledWith('n1')
  })

  it('renders Background and Controls components', () => {
    mockDag = {
      nodes: [{ id: 'n1', task: 'T', status: 'pending', depth: 0, dependsOn: [] }],
      edges: [],
    }
    render(<DAGView />)
    expect(screen.getByTestId('background')).toBeInTheDocument()
    expect(screen.getByTestId('controls')).toBeInTheDocument()
  })

  it('handles empty nodes array gracefully', () => {
    mockDag = { nodes: [], edges: [] }
    render(<DAGView />)
    expect(screen.getByTestId('reactflow')).toBeInTheDocument()
    expect(screen.getByTestId('node-count').textContent).toBe('0')
  })
})
