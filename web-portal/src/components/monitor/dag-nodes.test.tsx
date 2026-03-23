import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { FC } from 'react'

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

import { TaskNode, ReviewNode, GateNode } from './dag-nodes'

// Components only destructure { data } from NodeProps — cast to simplified FC for testing
type TaskData = { label: string; status: string; reviewStatus?: string }
type ReviewData = { label: string; status: string; reviewType?: string }
type GateData = { label: string; status: string }

const Task = TaskNode as unknown as FC<{ data: TaskData }>
const Review = ReviewNode as unknown as FC<{ data: ReviewData }>
const Gate = GateNode as unknown as FC<{ data: GateData }>

describe('TaskNode', () => {
  it('renders task label', () => {
    render(<Task data={{ label: 'Build frontend', status: 'pending' }} />)
    expect(screen.getByText('Build frontend')).toBeInTheDocument()
  })

  it('renders status dot with correct class for executing', () => {
    const { container } = render(<Task data={{ label: 'Task', status: 'executing' }} />)
    const dot = container.querySelector('.bg-accent')
    expect(dot).not.toBeNull()
  })

  it('renders status dot with correct class for completed', () => {
    const { container } = render(<Task data={{ label: 'Task', status: 'completed' }} />)
    const dot = container.querySelector('.bg-success')
    expect(dot).not.toBeNull()
  })

  it('renders status dot with correct class for failed', () => {
    const { container } = render(<Task data={{ label: 'Task', status: 'failed' }} />)
    const dot = container.querySelector('.bg-error')
    expect(dot).not.toBeNull()
  })

  it('shows review status when present and not none', () => {
    render(<Task data={{ label: 'Task', status: 'executing', reviewStatus: 'spec_review' }} />)
    expect(screen.getByText('Review: spec_review')).toBeInTheDocument()
  })

  it('hides review status when set to none', () => {
    render(<Task data={{ label: 'Task', status: 'pending', reviewStatus: 'none' }} />)
    expect(screen.queryByText(/Review:/)).not.toBeInTheDocument()
  })

  it('renders source and target handles', () => {
    render(<Task data={{ label: 'Task', status: 'pending' }} />)
    expect(screen.getByTestId('handle-target-top')).toBeInTheDocument()
    expect(screen.getByTestId('handle-source-bottom')).toBeInTheDocument()
  })
})

describe('ReviewNode', () => {
  it('renders review label', () => {
    render(<Review data={{ label: 'Spec Review', status: 'in_progress' }} />)
    expect(screen.getByText('Spec Review')).toBeInTheDocument()
  })

  it('renders review type when present', () => {
    render(<Review data={{ label: 'Review', status: 'pending', reviewType: 'quality_review' }} />)
    expect(screen.getByText('quality_review')).toBeInTheDocument()
  })

  it('uses warning border styling', () => {
    const { container } = render(<Review data={{ label: 'Review', status: 'pending' }} />)
    const node = container.firstElementChild as HTMLElement
    expect(node.className).toContain('border-warning')
  })
})

describe('GateNode', () => {
  it('renders gate label', () => {
    render(<Gate data={{ label: 'Approval Gate', status: 'waiting' }} />)
    expect(screen.getByText('Approval Gate')).toBeInTheDocument()
  })

  it('renders with warning border for waiting status', () => {
    const { container } = render(<Gate data={{ label: 'Gate', status: 'waiting' }} />)
    const node = container.firstElementChild as HTMLElement
    expect(node.className).toContain('border-warning')
  })

  it('renders with success border for approved status', () => {
    const { container } = render(<Gate data={{ label: 'Gate', status: 'approved' }} />)
    const node = container.firstElementChild as HTMLElement
    expect(node.className).toContain('border-success')
  })

  it('renders with error border for rejected status', () => {
    const { container } = render(<Gate data={{ label: 'Gate', status: 'rejected' }} />)
    const node = container.firstElementChild as HTMLElement
    expect(node.className).toContain('border-error')
  })

  it('renders source and target handles', () => {
    render(<Gate data={{ label: 'Gate', status: 'waiting' }} />)
    expect(screen.getByTestId('handle-target-top')).toBeInTheDocument()
    expect(screen.getByTestId('handle-source-bottom')).toBeInTheDocument()
  })
})
