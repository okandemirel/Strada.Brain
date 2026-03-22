import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// Mock tldraw — it requires browser APIs not available in jsdom
vi.mock('tldraw', () => ({
  Tldraw: (props: { onMount?: (editor: unknown) => void; shapeUtils?: unknown[] }) => {
    return <div data-testid="tldraw-canvas" data-shape-utils={props.shapeUtils?.length ?? 0} />
  },
}))
vi.mock('tldraw/tldraw.css', () => ({}))

// Mock custom shapes — avoids tldraw deep imports in unit tests
vi.mock('./custom-shapes', () => ({
  customShapeUtils: Array.from({ length: 9 }, (_, i) => ({ type: `shape-${i}` })),
}))

import CanvasPanel from './CanvasPanel'
import { useCanvasStore } from '../../stores/canvas-store'

describe('CanvasPanel', () => {
  beforeEach(() => {
    useCanvasStore.getState().reset()
  })

  it('renders tldraw canvas inside a full-size container', () => {
    render(<CanvasPanel />)
    const container = screen.getByTestId('canvas-panel')
    expect(container).toBeInTheDocument()
    expect(screen.getByTestId('tldraw-canvas')).toBeInTheDocument()
  })

  it('passes custom shape utils to tldraw', () => {
    render(<CanvasPanel />)
    const canvas = screen.getByTestId('tldraw-canvas')
    expect(canvas.getAttribute('data-shape-utils')).toBe('9')
  })
})
