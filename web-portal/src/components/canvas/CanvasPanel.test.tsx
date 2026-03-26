import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'

// ---------------------------------------------------------------------------
// Mocks — tldraw requires browser APIs not available in jsdom
// ---------------------------------------------------------------------------

const mockGetSnapshot = vi.fn(() => ({ store: { shapes: [] } }))
const mockLoadSnapshot = vi.fn()
const mockEditorOn = vi.fn()
const mockEditorRun = vi.fn((fn: () => void) => fn())
const mockCreateShape = vi.fn()
const mockGetShape = vi.fn((_id: string) => undefined as { id: string; type: string; props: Record<string, unknown> } | undefined)
const mockUpdateShape = vi.fn()
const mockDeleteShapes = vi.fn()

const mockEditor = {
  on: mockEditorOn,
  run: mockEditorRun,
  createShape: mockCreateShape,
  getShape: mockGetShape,
  updateShape: mockUpdateShape,
  deleteShapes: mockDeleteShapes,
  user: {
    updateUserPreferences: vi.fn(),
  },
  store: {
    getSnapshot: mockGetSnapshot,
    loadSnapshot: mockLoadSnapshot,
  },
  getViewportPageBounds: () => ({ center: { x: 500, y: 400 } }),
  zoomToFit: vi.fn(),
}

vi.mock('tldraw', () => ({
  Tldraw: (props: { onMount?: (editor: unknown) => void; shapeUtils?: unknown[]; components?: Record<string, unknown> }) => {
    // Simulate onMount callback — fire it on next tick so the component is rendered
    if (props.onMount) {
      setTimeout(() => props.onMount!(mockEditor), 0)
    }
    return (
      <div
        data-testid="tldraw-canvas"
        data-shape-utils={props.shapeUtils?.length ?? 0}
        data-has-components={props.components ? 'true' : 'false'}
        data-component-keys={props.components ? Object.keys(props.components).join(',') : ''}
      />
    )
  },
}))
vi.mock('tldraw/tldraw.css', () => ({}))

vi.mock('./custom-shapes', () => ({
  customShapeUtils: Array.from({ length: 9 }, (_, i) => ({ type: `shape-${i}` })),
  SHAPE_TYPES: {},
}))

vi.mock('./canvas-overrides', () => ({
  CustomToolbar: () => null,
  CustomContextMenu: () => null,
  TOOLBAR_SHAPES: [
    {
      type: 'code-block',
      label: '</>',
      title: 'Code Block',
      hint: 'code context',
      description: 'code context',
    },
  ],
  setExportJsonFn: vi.fn(),
}))

vi.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'dark' as const, toggleTheme: vi.fn() }),
}))

const mockApplyTemplate = vi.fn()
vi.mock('./canvas-templates', () => ({
  TEMPLATES: [
    { id: 'architecture', title: 'Architecture', description: 'test', icon: 'A' },
    { id: 'blank', title: 'Blank', description: 'test', icon: '+' },
  ],
  applyTemplate: (...args: unknown[]) => mockApplyTemplate(...args),
}))

// Mock CanvasWelcome - render template buttons directly for testing
vi.mock('./canvas-welcome', () => ({
  default: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <div data-testid="canvas-welcome">
      <button data-testid="canvas-template-architecture" onClick={() => onSelect('architecture')}>Architecture</button>
      <button data-testid="canvas-template-blank" onClick={() => onSelect('blank')}>Blank</button>
    </div>
  ),
}))

import CanvasPanel from './CanvasPanel'
import { useCanvasStore } from '../../stores/canvas-store'
import { useSessionStore } from '../../stores/session-store'
import { dispatchWorkspaceMessage } from '../../hooks/use-dashboard-socket'

// ---------------------------------------------------------------------------
// Fetch mock
// ---------------------------------------------------------------------------

const fetchSpy = vi.fn<typeof globalThis.fetch>()
vi.stubGlobal('fetch', fetchSpy)

// ---------------------------------------------------------------------------
// URL.createObjectURL / revokeObjectURL stubs
// ---------------------------------------------------------------------------

const createObjectURLSpy = vi.fn(() => 'blob:mock-url')
const revokeObjectURLSpy = vi.fn()
vi.stubGlobal('URL', { ...URL, createObjectURL: createObjectURLSpy, revokeObjectURL: revokeObjectURLSpy })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set up fetch to return a session with existing shapes so component skips welcome */
function setupSessionWithShapes(sessionId = 'test-sess') {
  fetchSpy.mockResolvedValueOnce(
    new Response(JSON.stringify({ canvas: { shapes: JSON.stringify({ store: {} }) } }), { status: 200 }),
  )
  useSessionStore.getState().setSession(sessionId, 'p1')
}

/** Enter editor mode via template selection */
async function enterEditorViaTemplate(user: ReturnType<typeof userEvent.setup>) {
  const btn = screen.getByTestId('canvas-template-architecture')
  await user.click(btn)
  // requestAnimationFrame fires the transition to 'editor'
  await act(async () => { vi.advanceTimersByTime(100) })
}

/** Enter editor mode via session restore (existing shapes) and render */
async function renderInEditorMode(sessionId = 'test-sess') {
  setupSessionWithShapes(sessionId)
  render(<CanvasPanel />)
  // Let the fetch resolve and mode transition happen
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  // Let tldraw onMount fire
  await act(async () => { vi.advanceTimersByTime(10) })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CanvasPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    useCanvasStore.getState().reset()
    useSessionStore.getState().reset()
    fetchSpy.mockReset()
    mockGetSnapshot.mockReturnValue({ store: { shapes: [] } })
    mockLoadSnapshot.mockReset()
    mockEditorOn.mockReset()
    mockCreateShape.mockReset()
    mockGetShape.mockReset()
    mockGetShape.mockReturnValue(undefined)
    mockUpdateShape.mockReset()
    mockDeleteShapes.mockReset()
    mockApplyTemplate.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -- Welcome state --------------------------------------------------------

  describe('Welcome state', () => {
    it('renders welcome screen by default', () => {
      render(<CanvasPanel />)
      expect(screen.getByTestId('canvas-welcome')).toBeInTheDocument()
      expect(screen.queryByTestId('tldraw-canvas')).not.toBeInTheDocument()
    })

    it('transitions to editor on template select', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(<CanvasPanel />)

      await enterEditorViaTemplate(user)

      // Welcome should be gone, tldraw should be visible
      expect(screen.queryByTestId('canvas-welcome')).not.toBeInTheDocument()
      expect(screen.getByTestId('tldraw-canvas')).toBeInTheDocument()
    })

    it('auto-opens the editor when agent shapes arrive', async () => {
      render(<CanvasPanel />)

      act(() => {
        useCanvasStore.getState().addPendingShapes([
          { type: 'diagram-node', id: 'agent-1', props: { label: 'Agent' }, source: 'agent' },
        ])
      })

      await act(async () => { vi.advanceTimersByTime(100) })

      expect(screen.queryByTestId('canvas-welcome')).not.toBeInTheDocument()
      expect(screen.getByTestId('tldraw-canvas')).toBeInTheDocument()
      expect(mockCreateShape).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'agent-1', type: 'diagram-node' }),
      )
      expect(useCanvasStore.getState().pendingShapes).toEqual([])
    })

    it('opens the editor when an agent canvas message is dispatched', async () => {
      render(<CanvasPanel />)

      act(() => {
        dispatchWorkspaceMessage({
          type: 'canvas:shapes_add',
          payload: {
            shapes: [
              { type: 'diagram-node', id: 'agent-msg-1', props: { label: 'Agent message' } },
            ],
          },
        })
      })

      await act(async () => { vi.advanceTimersByTime(100) })

      expect(screen.queryByTestId('canvas-welcome')).not.toBeInTheDocument()
      expect(screen.getByTestId('tldraw-canvas')).toBeInTheDocument()
      expect(mockCreateShape).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'agent-msg-1', type: 'diagram-node' }),
      )
    })

    it('skips welcome when session has existing shapes', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ canvas: { shapes: JSON.stringify({ store: {} }) } }), { status: 200 }),
      )
      useSessionStore.getState().setSession('has-shapes', 'p1')

      render(<CanvasPanel />)
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })

      expect(screen.queryByTestId('canvas-welcome')).not.toBeInTheDocument()
      expect(screen.getByTestId('tldraw-canvas')).toBeInTheDocument()
    })

    it('shows welcome toolbar without editor buttons', () => {
      render(<CanvasPanel />)
      expect(screen.getByTestId('canvas-toolbar')).toBeInTheDocument()
      expect(screen.queryByTestId('canvas-export-json')).not.toBeInTheDocument()
      expect(screen.queryByTestId('canvas-zoom-to-fit')).not.toBeInTheDocument()
    })
  })

  // -- Editor mode (restored via session shapes) ----------------------------

  it('renders tldraw canvas inside a full-size container', async () => {
    await renderInEditorMode()
    expect(screen.getByTestId('canvas-panel')).toBeInTheDocument()
    expect(screen.getByTestId('tldraw-canvas')).toBeInTheDocument()
  })

  it('passes custom shape utils to tldraw', async () => {
    await renderInEditorMode()
    const canvas = screen.getByTestId('tldraw-canvas')
    expect(canvas.getAttribute('data-shape-utils')).toBe('9')
  })

  it('passes Toolbar and ContextMenu components to tldraw', async () => {
    await renderInEditorMode()
    const canvas = screen.getByTestId('tldraw-canvas')
    expect(canvas.getAttribute('data-has-components')).toBe('true')
    expect(canvas.getAttribute('data-component-keys')).toContain('Toolbar')
    expect(canvas.getAttribute('data-component-keys')).toContain('ContextMenu')
  })

  it('renders toolbar with Export JSON button in editor mode', async () => {
    await renderInEditorMode()
    expect(screen.getByTestId('canvas-toolbar')).toBeInTheDocument()
    expect(screen.getByTestId('canvas-export-json')).toBeInTheDocument()
  })

  it('renders Zoom to Fit button in toolbar in editor mode', async () => {
    await renderInEditorMode()
    expect(screen.getByTestId('canvas-zoom-to-fit')).toBeInTheDocument()
  })

  it('renders quick insert dock in editor mode', async () => {
    await renderInEditorMode()
    expect(screen.getByTestId('canvas-quick-insert-dock')).toBeInTheDocument()
    expect(screen.getByTestId('canvas-quick-insert-code-block')).toBeInTheDocument()
  })

  // -- Dirty indicator ------------------------------------------------------

  it('shows unsaved indicator when dirty', async () => {
    useCanvasStore.getState().setDirty(true)
    await renderInEditorMode()
    expect(screen.getByTestId('canvas-dirty-indicator')).toBeInTheDocument()
    expect(screen.getByTestId('canvas-dirty-indicator').textContent).toBe('unsaved')
  })

  it('does not show dirty indicator when clean', async () => {
    await renderInEditorMode()
    expect(screen.queryByTestId('canvas-dirty-indicator')).not.toBeInTheDocument()
  })

  it('shows green saved indicator when not dirty', async () => {
    useCanvasStore.getState().setDirty(false)
    await renderInEditorMode()
    expect(screen.getByTestId('canvas-saved-indicator')).toBeInTheDocument()
  })

  // -- Auto-save ------------------------------------------------------------

  it('triggers auto-save after 5 seconds when dirty', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ canvas: { shapes: JSON.stringify({ store: {} }) } }), { status: 200 }),
    )
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ status: 'saved' }), { status: 200 }))
    useSessionStore.getState().setSession('test-sess', 'p1')

    render(<CanvasPanel />)

    // Let fetch resolve + transition to editor
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    // Wait for tldraw onMount
    await act(async () => { vi.advanceTimersByTime(10) })

    // Set dirty
    act(() => { useCanvasStore.getState().setDirty(true) })

    // Before 5s — no PUT fetch
    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/canvas/'),
      expect.objectContaining({ method: 'PUT' }),
    )

    // Advance past the debounce
    await act(async () => { vi.advanceTimersByTime(5100) })

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/canvas/test-sess',
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('does not auto-save when sessionId is null', async () => {
    render(<CanvasPanel />)

    act(() => { useCanvasStore.getState().setDirty(true) })
    await act(async () => { vi.advanceTimersByTime(6000) })

    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/canvas/'),
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('clears dirty flag after successful save', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ canvas: { shapes: JSON.stringify({ store: {} }) } }), { status: 200 }),
    )
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ status: 'saved' }), { status: 200 }))
    useSessionStore.getState().setSession('sess-clean', 'p1')

    render(<CanvasPanel />)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    await act(async () => { vi.advanceTimersByTime(10) })
    act(() => { useCanvasStore.getState().setDirty(true) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5100) })

    expect(useCanvasStore.getState().isDirty).toBe(false)
  })

  // -- Load on mount --------------------------------------------------------

  it('loads canvas state on mount when sessionId is set', async () => {
    const savedSnapshot = { store: { shapes: [{ type: 'rect' }] } }
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ canvas: { shapes: JSON.stringify(savedSnapshot) } }), { status: 200 }),
    )
    useSessionStore.getState().setSession('load-sess', 'p1')

    render(<CanvasPanel />)

    // Let fetch resolve
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })

    expect(fetchSpy).toHaveBeenCalledWith('/api/canvas/load-sess')
  })

  it('does not call load when sessionId is null', async () => {
    render(<CanvasPanel />)
    await act(async () => { vi.advanceTimersByTime(100) })

    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/canvas/'),
    )
  })

  it('handles load failure gracefully (non-ok response)', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 500 }))
    useSessionStore.getState().setSession('fail-sess', 'p1')

    // Should not throw
    render(<CanvasPanel />)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })

    // Should stay on welcome since no shapes came back
    expect(screen.getByTestId('canvas-welcome')).toBeInTheDocument()
    expect(mockLoadSnapshot).not.toHaveBeenCalled()
  })

  it('handles load failure gracefully (network error)', async () => {
    fetchSpy.mockRejectedValue(new Error('Network error'))
    useSessionStore.getState().setSession('net-fail', 'p1')

    // Should not throw
    render(<CanvasPanel />)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })

    expect(mockLoadSnapshot).not.toHaveBeenCalled()
  })

  // -- Export ---------------------------------------------------------------

  it('export JSON button creates a blob download', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const clickSpy = vi.fn()
    const originalCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: ElementCreationOptions) => {
      if (tag === 'a') {
        const el = originalCreateElement('a')
        el.click = clickSpy
        return el
      }
      return originalCreateElement(tag, options)
    })

    await renderInEditorMode()

    const btn = screen.getByTestId('canvas-export-json')
    await user.click(btn)

    expect(createObjectURLSpy).toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalled()
    expect(revokeObjectURLSpy).toHaveBeenCalled()

    vi.restoreAllMocks()
  })

  // -- Pending shapes -------------------------------------------------------

  it('processes pending shapes into the editor', async () => {
    await renderInEditorMode()

    act(() => {
      useCanvasStore.getState().addPendingShapes([
        { type: 'code-block', id: 'cb1', props: { code: 'hello' } },
      ])
    })

    expect(mockCreateShape).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'code-block', props: { code: 'hello' } }),
    )
    expect(useCanvasStore.getState().pendingShapes).toEqual([])
  })

  it('creates a shape from the quick insert dock', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await renderInEditorMode()

    await user.click(screen.getByTestId('canvas-quick-insert-code-block'))

    expect(mockCreateShape).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'code-block' }),
    )
  })

  it('applies pending updates to existing editor shapes', async () => {
    mockGetShape.mockImplementation((id: string) => (
      id === 'cb1' ? { id: 'cb1', type: 'code-block', props: { code: 'before' } } : undefined
    ))
    await renderInEditorMode()

    act(() => {
      useCanvasStore.getState().updatePendingShapes([
        { id: 'cb1', props: { code: 'after' }, source: 'agent' },
      ])
    })

    expect(mockUpdateShape).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cb1', type: 'code-block', props: { code: 'after' } }),
    )
    expect(useCanvasStore.getState().pendingUpdates).toEqual([])
  })

  it('applies pending removals to existing editor shapes', async () => {
    mockGetShape.mockImplementation((id: string) => (
      id === 'cb1' ? { id: 'cb1', type: 'code-block', props: { code: 'before' } } : undefined
    ))
    await renderInEditorMode()

    act(() => {
      useCanvasStore.getState().removePendingShapeIds(['cb1'])
    })

    expect(mockDeleteShapes).toHaveBeenCalledWith(['cb1'])
    expect(useCanvasStore.getState().pendingRemovals).toEqual([])
  })
})
