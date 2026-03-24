import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('tldraw', () => {
  // Stubs required by custom-shapes.tsx (transitive import)
  class BaseBoxShapeUtil {
    static type = ''
    static props = {}
  }
  const HTMLContainer = ({ children }: { children: React.ReactNode }) => <div>{children}</div>
  const T = { number: 0, string: Object.assign('', { optional: () => undefined }) }

  return {
    BaseBoxShapeUtil,
    HTMLContainer,
    T,
    DefaultToolbar: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="default-toolbar">{children}</div>
    ),
    DefaultToolbarContent: () => <div data-testid="default-toolbar-content" />,
    DefaultContextMenu: ({ children, ...rest }: { children: React.ReactNode }) => (
      <div data-testid="default-context-menu" {...rest}>{children}</div>
    ),
    DefaultContextMenuContent: () => <div data-testid="default-context-menu-content" />,
    TldrawUiMenuGroup: ({ children, id }: { children: React.ReactNode; id: string }) => (
      <div data-testid={`menu-group-${id}`}>{children}</div>
    ),
    TldrawUiMenuSubmenu: ({ children, id, label }: { children: React.ReactNode; id: string; label: string }) => (
      <div data-testid={`menu-submenu-${id}`} data-label={label}>{children}</div>
    ),
    TldrawUiMenuItem: ({ id, label, onSelect }: { id: string; label: string; onSelect: (_s: string) => void }) => (
      <button data-testid={`menu-item-${id}`} data-label={label} onClick={() => onSelect('menu')} />
    ),
    useEditor: () => ({
      createShape: vi.fn(),
      getViewportPageBounds: () => ({ center: { x: 500, y: 400 } }),
      inputs: { currentPagePoint: { x: 300, y: 200 } },
      zoomToFit: vi.fn(),
      selectAll: vi.fn(),
    }),
  }
})
vi.mock('./canvas-styles.css', () => ({}))

import { CustomToolbar, CustomContextMenu } from './canvas-overrides'

describe('CustomToolbar', () => {
  it('renders default toolbar content', () => {
    render(<CustomToolbar />)
    expect(screen.getByTestId('default-toolbar')).toBeInTheDocument()
    expect(screen.getByTestId('default-toolbar-content')).toBeInTheDocument()
  })

  it('renders Strada shape buttons', () => {
    render(<CustomToolbar />)
    expect(screen.getByTestId('strada-btn-code-block')).toBeInTheDocument()
    expect(screen.getByTestId('strada-btn-diagram-node')).toBeInTheDocument()
    expect(screen.getByTestId('strada-btn-task-card')).toBeInTheDocument()
    expect(screen.getByTestId('strada-btn-note-block')).toBeInTheDocument()
    expect(screen.getByTestId('strada-btn-terminal-block')).toBeInTheDocument()
    expect(screen.getByTestId('strada-btn-file-card')).toBeInTheDocument()
  })
})

describe('CustomContextMenu', () => {
  it('renders default context menu content', () => {
    render(<CustomContextMenu />)
    expect(screen.getByTestId('default-context-menu')).toBeInTheDocument()
    expect(screen.getByTestId('default-context-menu-content')).toBeInTheDocument()
  })

  it('renders Add Shape submenu with categories', () => {
    render(<CustomContextMenu />)
    expect(screen.getByTestId('menu-submenu-strada-add-shape')).toBeInTheDocument()
    expect(screen.getByTestId('menu-submenu-strada-code')).toBeInTheDocument()
    expect(screen.getByTestId('menu-submenu-strada-diagram')).toBeInTheDocument()
    expect(screen.getByTestId('menu-submenu-strada-planning')).toBeInTheDocument()
    expect(screen.getByTestId('menu-submenu-strada-media')).toBeInTheDocument()
  })

  it('renders utility items (Select All, Zoom to Fit)', () => {
    render(<CustomContextMenu />)
    expect(screen.getByTestId('menu-item-strada-select-all')).toBeInTheDocument()
    expect(screen.getByTestId('menu-item-strada-zoom-to-fit')).toBeInTheDocument()
  })
})
