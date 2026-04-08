import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// Mock ReactFlow components
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  NodeResizer: () => null,
}))

// Mock card-registry to avoid lazy loading in tests
vi.mock('./card-registry', () => ({
  CARD_RENDERERS: {
    'task-card': ({ props }: { type: string; props: Record<string, unknown> }) => (
      <div>{String(props.title ?? '')}</div>
    ),
    'note-block': ({ props }: { type: string; props: Record<string, unknown> }) => (
      <div>{String(props.content ?? '')}</div>
    ),
    'code-block': ({ props }: { type: string; props: Record<string, unknown> }) => (
      <div>{String(props.code ?? '')}</div>
    ),
  },
}))

import BaseCard from './BaseCard'

const defaultProps = {
  id: 'test-1',
  type: 'baseCard' as const,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
  isConnectable: true,
  zIndex: 1,
}

describe('BaseCard', () => {
  it('renders card type badge in header', () => {
    render(<BaseCard {...defaultProps} data={{ cardType: 'task-card', props: { title: 'My Task' } }} selected={false} />)
    expect(screen.getByText('task-card')).toBeTruthy()
  })

  it('renders content from TypeRenderer', () => {
    render(<BaseCard {...defaultProps} data={{ cardType: 'note-block', props: { content: 'Hello world' } }} selected={false} />)
    expect(screen.getByText('Hello world')).toBeTruthy()
  })

  it('shows AI badge for agent-sourced cards', () => {
    render(<BaseCard {...defaultProps} data={{ cardType: 'code-block', props: { code: 'test' }, source: 'agent' }} selected={false} />)
    expect(screen.getByText('AI')).toBeTruthy()
  })

  it('does not show AI badge for user-sourced cards', () => {
    render(<BaseCard {...defaultProps} data={{ cardType: 'note-block', props: {}, source: 'user' }} selected={false} />)
    expect(screen.queryByText('AI')).toBeNull()
  })

  it('shows unknown type message for unregistered types', () => {
    render(<BaseCard {...defaultProps} data={{ cardType: 'unknown-type', props: {} }} selected={false} />)
    expect(screen.getByText(/Unknown type/)).toBeTruthy()
  })
})
