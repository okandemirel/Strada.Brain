import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// Mock @xyflow/react Handle component (requires canvas internals)
vi.mock('@xyflow/react', () => ({
  Handle: ({ type, position }: { type: string; position: string }) => (
    <div data-testid={`handle-${type}-${position}`} />
  ),
  Position: {
    Top: 'top',
    Bottom: 'bottom',
    Left: 'left',
    Right: 'right',
  },
}))

import type { NodeProps, Node } from '@xyflow/react'
import { TaskNode, ReviewNode, GateNode } from './dag-nodes'

// Helper to create NodeProps-like objects
function makeNodeProps<T extends Record<string, unknown>>(data: T): NodeProps<Node<T>> {
  return {
    id: 'test-node',
    data,
    type: 'task',
    selected: false,
    isConnectable: true,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    dragging: false,
    dragHandle: undefined,
    parentId: undefined,
    sourcePosition: undefined,
    targetPosition: undefined,
    width: 200,
    height: 80,
  } as NodeProps<Node<T>>
}

describe('TaskNode', () => {
  it('renders task label', () => {
    render(<TaskNode {...makeNodeProps({ label: 'Build frontend', status: 'pending' })} />)
    expect(screen.getByText('Build frontend')).toBeInTheDocument()
  })

  it('renders status dot with correct class for executing', () => {
    const { container } = render(
      <TaskNode {...makeNodeProps({ label: 'Task', status: 'executing' })} />,
    )
    const dot = container.querySelector('.bg-accent')
    expect(dot).not.toBeNull()
  })

  it('renders status dot with correct class for completed', () => {
    const { container } = render(
      <TaskNode {...makeNodeProps({ label: 'Task', status: 'completed' })} />,
    )
    const dot = container.querySelector('.bg-success')
    expect(dot).not.toBeNull()
  })

  it('renders status dot with correct class for failed', () => {
    const { container } = render(
      <TaskNode {...makeNodeProps({ label: 'Task', status: 'failed' })} />,
    )
    const dot = container.querySelector('.bg-error')
    expect(dot).not.toBeNull()
  })

  it('shows review status when present and not none', () => {
    render(
      <TaskNode
        {...makeNodeProps({ label: 'Task', status: 'executing', reviewStatus: 'spec_review' })}
      />,
    )
    expect(screen.getByText('Review: spec_review')).toBeInTheDocument()
  })

  it('hides review status when set to none', () => {
    render(
      <TaskNode {...makeNodeProps({ label: 'Task', status: 'pending', reviewStatus: 'none' })} />,
    )
    expect(screen.queryByText(/Review:/)).not.toBeInTheDocument()
  })

  it('renders source and target handles', () => {
    render(<TaskNode {...makeNodeProps({ label: 'Task', status: 'pending' })} />)
    expect(screen.getByTestId('handle-target-top')).toBeInTheDocument()
    expect(screen.getByTestId('handle-source-bottom')).toBeInTheDocument()
  })
})

describe('ReviewNode', () => {
  it('renders review label', () => {
    render(<ReviewNode {...makeNodeProps({ label: 'Spec Review', status: 'in_progress' })} />)
    expect(screen.getByText('Spec Review')).toBeInTheDocument()
  })

  it('renders review type when present', () => {
    render(
      <ReviewNode
        {...makeNodeProps({ label: 'Review', status: 'pending', reviewType: 'quality_review' })}
      />,
    )
    expect(screen.getByText('quality_review')).toBeInTheDocument()
  })

  it('uses warning border styling', () => {
    const { container } = render(
      <ReviewNode {...makeNodeProps({ label: 'Review', status: 'pending' })} />,
    )
    const node = container.firstElementChild as HTMLElement
    expect(node.className).toContain('border-warning')
  })
})

describe('GateNode', () => {
  it('renders gate label', () => {
    render(<GateNode {...makeNodeProps({ label: 'Approval Gate', status: 'waiting' })} />)
    expect(screen.getByText('Approval Gate')).toBeInTheDocument()
  })

  it('renders with warning border for waiting status', () => {
    const { container } = render(
      <GateNode {...makeNodeProps({ label: 'Gate', status: 'waiting' })} />,
    )
    const node = container.firstElementChild as HTMLElement
    expect(node.className).toContain('border-warning')
  })

  it('renders with success border for approved status', () => {
    const { container } = render(
      <GateNode {...makeNodeProps({ label: 'Gate', status: 'approved' })} />,
    )
    const node = container.firstElementChild as HTMLElement
    expect(node.className).toContain('border-success')
  })

  it('renders with error border for rejected status', () => {
    const { container } = render(
      <GateNode {...makeNodeProps({ label: 'Gate', status: 'rejected' })} />,
    )
    const node = container.firstElementChild as HTMLElement
    expect(node.className).toContain('border-error')
  })

  it('renders source and target handles', () => {
    render(<GateNode {...makeNodeProps({ label: 'Gate', status: 'waiting' })} />)
    expect(screen.getByTestId('handle-target-top')).toBeInTheDocument()
    expect(screen.getByTestId('handle-source-bottom')).toBeInTheDocument()
  })
})
