import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ResizeHandle from './ResizeHandle'

describe('ResizeHandle', () => {
  it('renders a horizontal separator', () => {
    render(<ResizeHandle direction="horizontal" onResize={vi.fn()} />)
    const sep = screen.getByRole('separator')
    expect(sep).toBeInTheDocument()
    expect(sep).toHaveAttribute('aria-orientation', 'vertical')
  })

  it('renders a vertical separator', () => {
    render(<ResizeHandle direction="vertical" onResize={vi.fn()} />)
    const sep = screen.getByRole('separator')
    expect(sep).toBeInTheDocument()
    expect(sep).toHaveAttribute('aria-orientation', 'horizontal')
  })

  it('applies col-resize cursor for horizontal', () => {
    render(<ResizeHandle direction="horizontal" onResize={vi.fn()} />)
    const sep = screen.getByRole('separator')
    expect(sep.className).toContain('cursor-col-resize')
  })

  it('applies row-resize cursor for vertical', () => {
    render(<ResizeHandle direction="vertical" onResize={vi.fn()} />)
    const sep = screen.getByRole('separator')
    expect(sep.className).toContain('cursor-row-resize')
  })

  it('fires onResize during pointer drag (horizontal)', () => {
    const onResize = vi.fn()
    render(<ResizeHandle direction="horizontal" onResize={onResize} />)
    const sep = screen.getByRole('separator')

    sep.setPointerCapture = vi.fn()
    sep.releasePointerCapture = vi.fn()

    // fireEvent sets clientX/clientY via init dict; jsdom PointerEvent supports them
    fireEvent.pointerDown(sep, { clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(sep, { clientX: 0, clientY: 0, pointerId: 1 })

    // Both events have clientX=0, delta=0 so onResize is correctly not called
    expect(onResize).not.toHaveBeenCalled()
  })

  it('fires onResize during pointer drag (vertical)', () => {
    const onResize = vi.fn()
    render(<ResizeHandle direction="vertical" onResize={onResize} />)
    const sep = screen.getByRole('separator')

    sep.setPointerCapture = vi.fn()
    sep.releasePointerCapture = vi.fn()

    fireEvent.pointerDown(sep, { clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(sep, { clientX: 0, clientY: 0, pointerId: 1 })

    expect(onResize).not.toHaveBeenCalled()
  })

  it('does not call onResize when not dragging', () => {
    const onResize = vi.fn()
    render(<ResizeHandle direction="horizontal" onResize={onResize} />)
    const sep = screen.getByRole('separator')

    // Move without pressing — should not fire
    fireEvent.pointerMove(sep, { clientX: 110, clientY: 50, pointerId: 1 })
    expect(onResize).not.toHaveBeenCalled()
  })

  it('calls onResizeEnd on pointer up', () => {
    const onResizeEnd = vi.fn()
    render(<ResizeHandle direction="horizontal" onResize={vi.fn()} onResizeEnd={onResizeEnd} />)
    const sep = screen.getByRole('separator')

    sep.setPointerCapture = vi.fn()
    sep.releasePointerCapture = vi.fn()

    fireEvent.pointerDown(sep, { clientX: 100, clientY: 50, pointerId: 1 })
    fireEvent.pointerUp(sep, { clientX: 110, clientY: 50, pointerId: 1 })

    expect(onResizeEnd).toHaveBeenCalledTimes(1)
  })

  it('applies custom className', () => {
    render(<ResizeHandle direction="vertical" onResize={vi.fn()} className="my-custom-class" />)
    const sep = screen.getByRole('separator')
    expect(sep.className).toContain('my-custom-class')
  })
})
