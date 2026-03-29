import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ---------------------------------------------------------------------------
// Mocks -- @dnd-kit and child components
// ---------------------------------------------------------------------------

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div data-testid="dnd-context">{children}</div>,
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    isDragging: false,
  }),
}))

vi.mock('./canvas-cards', () => ({
  CARD_COMPONENTS: {
    'code-block': ({ shape }: { shape: { id: string; props: Record<string, unknown> } }) => (
      <div data-testid={`card-${shape.id}`} data-type="code-block">{String(shape.props.code ?? '')}</div>
    ),
    'task-card': ({ shape }: { shape: { id: string; props: Record<string, unknown> } }) => (
      <div data-testid={`card-${shape.id}`} data-type="task-card">{String(shape.props.title ?? '')}</div>
    ),
    'goal-summary': ({ shape }: { shape: { id: string; props: Record<string, unknown> } }) => (
      <div data-testid={`card-${shape.id}`} data-type="goal-summary">{String(shape.props.title ?? '')}</div>
    ),
    'diagram-node': ({ shape }: { shape: { id: string; props: Record<string, unknown> } }) => (
      <div data-testid={`card-${shape.id}`} data-type="diagram-node">{String(shape.props.label ?? '')}</div>
    ),
    'note-block': ({ shape }: { shape: { id: string; props: Record<string, unknown> } }) => (
      <div data-testid={`card-${shape.id}`} data-type="note-block">{String(shape.props.content ?? '')}</div>
    ),
  },
}))

vi.mock('./canvas-viewport', () => ({
  default: ({ children, ...rest }: { children: React.ReactNode; x: number; y: number; zoom: number }) => (
    <div data-testid="canvas-viewport" data-x={rest.x} data-y={rest.y} data-zoom={rest.zoom}>{children}</div>
  ),
}))

vi.mock('./canvas-controls', () => ({
  default: ({ zoom }: { zoom: number }) => <div data-testid="canvas-controls" data-zoom={zoom} />,
}))

vi.mock('./canvas-minimap', () => ({
  default: () => <div data-testid="canvas-minimap" />,
}))

vi.mock('./canvas-connections', () => ({
  default: ({ connections }: { connections: { id: string }[] }) => (
    <div data-testid="canvas-connections" data-count={connections.length} />
  ),
}))

vi.mock('./canvas-empty-state', () => ({
  default: ({ onVisualize }: { onVisualize: () => void }) => (
    <div data-testid="canvas-empty-state">
      <button data-testid="canvas-visualize-btn" onClick={onVisualize}>Visualize</button>
    </div>
  ),
}))

import CanvasPanel from './CanvasPanel'
import { useCanvasStore } from '../../stores/canvas-store'
import { useMonitorStore } from '../../stores/monitor-store'
import { useSessionStore } from '../../stores/session-store'
import type { ResolvedShape } from './canvas-types'

// ---------------------------------------------------------------------------
// Fetch mock
// ---------------------------------------------------------------------------

const fetchSpy = vi.fn<typeof globalThis.fetch>()
vi.stubGlobal('fetch', fetchSpy)

function createStorageMock() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CanvasPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const storage = createStorageMock()
    Object.defineProperty(window, 'localStorage', { value: storage, configurable: true })
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
    useCanvasStore.getState().reset()
    useMonitorStore.getState().clearMonitor()
    useSessionStore.getState().reset()
    fetchSpy.mockReset()
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ canvas: null }), { status: 200 }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -- Empty state -----------------------------------------------------------

  describe('Empty state', () => {
    it('renders empty state when no shapes exist', () => {
      render(<CanvasPanel />)
      expect(screen.getByTestId('canvas-empty-state')).toBeInTheDocument()
    })

    it('does not render viewport when shapes are empty', () => {
      render(<CanvasPanel />)
      expect(screen.queryByTestId('canvas-viewport')).not.toBeInTheDocument()
    })

    it('does not render minimap when shapes are empty', () => {
      render(<CanvasPanel />)
      expect(screen.queryByTestId('canvas-minimap')).not.toBeInTheDocument()
    })

    it('always renders canvas controls', () => {
      render(<CanvasPanel />)
      expect(screen.getByTestId('canvas-controls')).toBeInTheDocument()
    })
  })

  // -- Toolbar header --------------------------------------------------------

  describe('Toolbar header', () => {
    it('shows CANVAS badge', () => {
      render(<CanvasPanel />)
      expect(screen.getByText('CANVAS')).toBeInTheDocument()
    })

    it('shows session ID when set', () => {
      useSessionStore.getState().setSession('abcdefghijklmnop', 'p1')
      render(<CanvasPanel />)
      expect(screen.getByText('abcdefghijklmnop')).toBeInTheDocument()
    })

    it('shows truncated session ID for long IDs', () => {
      useSessionStore.getState().setSession('abcdefghijklmnopqrstuvwxyz1234567890', 'p1')
      render(<CanvasPanel />)
      expect(screen.getByText('abcdefgh...567890')).toBeInTheDocument()
    })
  })

  // -- Loading shapes from session -------------------------------------------

  describe('Load on session change', () => {
    it('fetches canvas when sessionId changes', async () => {
      useSessionStore.getState().setSession('load-sess', 'p1')
      render(<CanvasPanel />)
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })

      expect(fetchSpy).toHaveBeenCalledWith('/api/canvas/load-sess')
    })

    it('does not fetch when sessionId is null', async () => {
      render(<CanvasPanel />)
      await act(async () => { vi.advanceTimersByTime(100) })

      expect(fetchSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('/api/canvas/'),
      )
    })

    it('loads shapes from server response', async () => {
      const savedShapes: ResolvedShape[] = [
        { id: 'cb1', type: 'code-block', x: 100, y: 200, w: 400, h: 240, props: { code: 'hello' } },
      ]
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ canvas: { shapes: JSON.stringify(savedShapes) } }), { status: 200 }),
      )
      useSessionStore.getState().setSession('load-sess', 'p1')

      render(<CanvasPanel />)
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })

      expect(screen.getByTestId('card-cb1')).toBeInTheDocument()
      expect(screen.queryByTestId('canvas-empty-state')).not.toBeInTheDocument()
    })

    it('migrates tldraw snapshot format', async () => {
      const tldrawSnapshot = {
        store: {
          'shape:s1': {
            typeName: 'shape',
            id: 'shape:s1',
            type: 'code-block',
            x: 50,
            y: 75,
            props: { code: 'migrated', w: 400, h: 240 },
          },
          'page:default': {
            typeName: 'page',
            id: 'page:default',
          },
        },
      }
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ canvas: { shapes: JSON.stringify(tldrawSnapshot) } }), { status: 200 }),
      )
      useSessionStore.getState().setSession('migrate-sess', 'p1')

      render(<CanvasPanel />)
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })

      expect(screen.getByTestId('card-shape:s1')).toBeInTheDocument()
    })

    it('handles load failure gracefully', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network error'))
      useSessionStore.getState().setSession('fail-sess', 'p1')

      render(<CanvasPanel />)
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })

      expect(screen.getByTestId('canvas-empty-state')).toBeInTheDocument()
    })
  })

  // -- Pending shapes --------------------------------------------------------

  describe('Pending mutations', () => {
    it('processes pending shapes and renders them', async () => {
      render(<CanvasPanel />)

      act(() => {
        useCanvasStore.getState().addPendingShapes([
          { type: 'code-block', id: 'pend-1', props: { code: 'test', w: 400, h: 240 } },
        ])
      })

      await act(async () => { vi.advanceTimersByTime(10) })

      expect(screen.getByTestId('card-pend-1')).toBeInTheDocument()
      expect(useCanvasStore.getState().pendingShapes).toEqual([])
    })

    it('clears pending removals', async () => {
      act(() => {
        useCanvasStore.getState().setShapes([
          { id: 'rm-1', type: 'code-block', x: 0, y: 0, w: 400, h: 240, props: { code: 'bye' } },
        ])
      })

      render(<CanvasPanel />)
      expect(screen.getByTestId('card-rm-1')).toBeInTheDocument()

      act(() => {
        useCanvasStore.getState().removePendingShapeIds(['rm-1'])
      })

      await act(async () => { vi.advanceTimersByTime(10) })

      expect(screen.queryByTestId('card-rm-1')).not.toBeInTheDocument()
      expect(useCanvasStore.getState().pendingRemovals).toEqual([])
    })

    it('tracks agent visual count from pending shapes', async () => {
      render(<CanvasPanel />)

      act(() => {
        useCanvasStore.getState().addPendingShapes([
          { type: 'code-block', id: 'ag-1', props: { code: 'a', w: 400, h: 240 }, source: 'agent' },
          { type: 'code-block', id: 'ag-2', props: { code: 'b', w: 400, h: 240 }, source: 'agent' },
        ])
      })

      await act(async () => { vi.advanceTimersByTime(10) })

      expect(screen.getByText('Agent visuals 2')).toBeInTheDocument()
    })
  })

  // -- Auto-save -------------------------------------------------------------

  describe('Auto-save', () => {
    it('triggers auto-save after 5 seconds when dirty', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify({ status: 'saved' }), { status: 200 }))
      useSessionStore.getState().setSession('save-sess', 'p1')

      act(() => {
        useCanvasStore.getState().setShapes([
          { id: 's1', type: 'code-block', x: 0, y: 0, w: 400, h: 240, props: { code: 'test' } },
        ])
        useCanvasStore.getState().setDirty(true)
      })

      render(<CanvasPanel />)

      expect(fetchSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('/api/canvas/'),
        expect.objectContaining({ method: 'PUT' }),
      )

      await act(async () => { await vi.advanceTimersByTimeAsync(5100) })

      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/canvas/save-sess',
        expect.objectContaining({ method: 'PUT' }),
      )
    })

    it('does not auto-save when sessionId is null', async () => {
      act(() => { useCanvasStore.getState().setDirty(true) })
      render(<CanvasPanel />)
      await act(async () => { vi.advanceTimersByTime(6000) })

      expect(fetchSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('/api/canvas/'),
        expect.objectContaining({ method: 'PUT' }),
      )
    })
  })

  // -- Monitor fallback (Visualize button) -----------------------------------

  describe('Monitor fallback', () => {
    it('builds fallback shapes from DAG when visualize is clicked', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

      act(() => {
        useMonitorStore.getState().setActiveRootId('root-1')
        useMonitorStore.getState().setDAG({
          nodes: [
            { id: 'task-a', title: 'Inspect editor', status: 'failed', reviewStatus: 'none' },
            { id: 'task-b', title: 'Audit levels', status: 'executing', reviewStatus: 'none' },
          ],
          edges: [{ source: 'task-a', target: 'task-b' }],
        })
        useMonitorStore.getState().addTask({
          id: 'task-a', nodeId: 'task-a', rootId: 'root-1',
          title: 'Inspect editor', status: 'failed', reviewStatus: 'none',
        })
        useMonitorStore.getState().addTask({
          id: 'task-b', nodeId: 'task-b', rootId: 'root-1',
          title: 'Audit levels', status: 'executing', reviewStatus: 'none',
        })
      })

      render(<CanvasPanel />)
      expect(screen.getByTestId('canvas-empty-state')).toBeInTheDocument()

      await user.click(screen.getByTestId('canvas-visualize-btn'))
      await act(async () => { vi.advanceTimersByTime(50) })

      expect(screen.queryByTestId('canvas-empty-state')).not.toBeInTheDocument()
      expect(screen.getByTestId('card-goal-summary-root-1')).toBeInTheDocument()
      expect(screen.getByTestId('card-goal-task-task-a')).toBeInTheDocument()
      expect(screen.getByTestId('card-goal-task-task-b')).toBeInTheDocument()
    })
  })

  // -- Canvas with shapes renders viewport + minimap -------------------------

  describe('Canvas rendering', () => {
    it('renders viewport and minimap when shapes exist', () => {
      act(() => {
        useCanvasStore.getState().setShapes([
          { id: 's1', type: 'code-block', x: 0, y: 0, w: 400, h: 240, props: { code: 'test' } },
        ])
      })

      render(<CanvasPanel />)

      expect(screen.getByTestId('canvas-viewport')).toBeInTheDocument()
      expect(screen.getByTestId('canvas-minimap')).toBeInTheDocument()
      expect(screen.queryByTestId('canvas-empty-state')).not.toBeInTheDocument()
    })

    it('renders connections inside the viewport', () => {
      act(() => {
        useCanvasStore.getState().setShapes([
          { id: 's1', type: 'code-block', x: 0, y: 0, w: 400, h: 240, props: {} },
          { id: 's2', type: 'code-block', x: 500, y: 0, w: 400, h: 240, props: {} },
        ])
        useCanvasStore.getState().setConnections([
          { id: 'c1', from: 's1', to: 's2' },
        ])
      })

      render(<CanvasPanel />)

      const conns = screen.getByTestId('canvas-connections')
      expect(conns.getAttribute('data-count')).toBe('1')
    })

    it('passes viewport props to the viewport component', () => {
      act(() => {
        useCanvasStore.getState().setShapes([
          { id: 's1', type: 'code-block', x: 0, y: 0, w: 400, h: 240, props: {} },
        ])
        useCanvasStore.getState().setViewport({ x: 10, y: 20, zoom: 0.8 })
      })

      render(<CanvasPanel />)

      const vp = screen.getByTestId('canvas-viewport')
      expect(vp.getAttribute('data-zoom')).toBe('0.8')
    })

    it('passes zoom to canvas controls', () => {
      act(() => {
        useCanvasStore.getState().setShapes([
          { id: 's1', type: 'code-block', x: 0, y: 0, w: 400, h: 240, props: {} },
        ])
        useCanvasStore.getState().setViewport({ x: 0, y: 0, zoom: 1.5 })
      })

      render(<CanvasPanel />)

      const controls = screen.getByTestId('canvas-controls')
      expect(controls.getAttribute('data-zoom')).toBe('1.5')
    })
  })
})
