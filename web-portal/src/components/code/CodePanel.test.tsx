import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mock child components
// ---------------------------------------------------------------------------
vi.mock('./FileTree', () => ({
  default: () => <div data-testid="file-tree">FileTree</div>,
}))

vi.mock('./CodeEditor', () => ({
  default: () => <div data-testid="code-editor">CodeEditor</div>,
}))

vi.mock('./Terminal', () => ({
  default: () => <div data-testid="terminal">Terminal</div>,
}))

// Mock react-resizable-panels — render children with resize handles
vi.mock('react-resizable-panels', () => ({
  PanelGroup: ({ children, ...props }: { children: React.ReactNode; direction: string }) => (
    <div data-testid={`panel-group-${props.direction}`}>{children}</div>
  ),
  Panel: ({ children }: { children: React.ReactNode }) => <div data-testid="panel">{children}</div>,
  PanelResizeHandle: ({ className }: { className?: string }) => (
    <div data-testid="resize-handle" className={className} />
  ),
}))

import CodePanel from './CodePanel'

describe('CodePanel', () => {
  // 1
  it('renders FileTree, CodeEditor, and Terminal components', () => {
    render(<CodePanel />)
    expect(screen.getByTestId('file-tree')).toBeInTheDocument()
    expect(screen.getByTestId('code-editor')).toBeInTheDocument()
    expect(screen.getByTestId('terminal')).toBeInTheDocument()
  })

  // 2
  it('renders resize handles', () => {
    render(<CodePanel />)
    const handles = screen.getAllByTestId('resize-handle')
    // Two resize handles: one horizontal (between file tree and editor), one vertical (between editor and terminal)
    expect(handles).toHaveLength(2)
  })

  // 3
  it('renders horizontal panel group for file tree and editor area', () => {
    render(<CodePanel />)
    expect(screen.getByTestId('panel-group-horizontal')).toBeInTheDocument()
  })

  // 4
  it('renders vertical panel group for editor and terminal', () => {
    render(<CodePanel />)
    expect(screen.getByTestId('panel-group-vertical')).toBeInTheDocument()
  })

  // 5
  it('renders multiple panels', () => {
    render(<CodePanel />)
    const panels = screen.getAllByTestId('panel')
    // 4 panels: file tree, right area, editor, terminal
    expect(panels.length).toBeGreaterThanOrEqual(4)
  })

  // 6
  it('renders with proper scroll containment classes (min-h-0, overflow-hidden)', () => {
    const { container } = render(<CodePanel />)
    const outerDiv = container.firstElementChild as HTMLElement
    expect(outerDiv.className).toContain('h-full')
    expect(outerDiv.className).toContain('flex')
    expect(outerDiv.className).toContain('flex-col')
    expect(outerDiv.className).toContain('min-h-0')
    expect(outerDiv.className).toContain('overflow-hidden')
  })
})
