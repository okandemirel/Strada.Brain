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
const mockGetShape = vi.fn(() => undefined)
const mockUpdateShape = vi.fn()

const mockEditor = {
  on: mockEditorOn,
  run: mockEditorRun,
  createShape: mockCreateShape,
  getShape: mockGetShape,
  updateShape: mockUpdateShape,
  user: {
    updateUserPreferences: vi.fn(),
  },
  store: {
    getSnapshot: mockGetSnapshot,
    loadSnapshot: mockLoadSnapshot,
  },
}

vi.mock('tldraw', () => ({
  Tldraw: (props: { onMount?: (editor: unknown) => void; shapeUtils?: unknown[] }) => {
    // Simulate onMount callback — fire it on next tick so the component is rendered
    if (props.onMount) {
      setTimeout(() => props.onMount!(mockEditor), 0)
    }
    return <div data-testid="tldraw-canvas" data-shape-utils={props.shapeUtils?.length ?? 0} />
  },
}))
vi.mock('tldraw/tldraw.css', () => ({}))

vi.mock('./custom-shapes', () => ({
  customShapeUtils: Array.from({ length: 9 }, (_, i) => ({ type: `shape-${i}` })),
}))

vi.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'dark' as const, toggleTheme: vi.fn() }),
}))

import CanvasPanel from './CanvasPanel'
import { useCanvasStore } from '../../stores/canvas-store'
import { useSessionStore } from '../../stores/session-store'

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
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders tldraw canvas inside a full-size container', () => {
    render(<CanvasPanel />)
    expect(screen.getByTestId('canvas-panel')).toBeInTheDocument()
    expect(screen.getByTestId('tldraw-canvas')).toBeInTheDocument()
  })

  it('passes custom shape utils to tldraw', () => {
    render(<CanvasPanel />)
    const canvas = screen.getByTestId('tldraw-canvas')
    expect(canvas.getAttribute('data-shape-utils')).toBe('9')
  })

  it('renders toolbar with Export JSON button', () => {
    render(<CanvasPanel />)
    expect(screen.getByTestId('canvas-toolbar')).toBeInTheDocument()
    expect(screen.getByTestId('canvas-export-json')).toBeInTheDocument()
  })

  // -- Dirty indicator ------------------------------------------------------

  it('shows unsaved indicator when dirty', () => {
    useCanvasStore.getState().setDirty(true)
    render(<CanvasPanel />)
    expect(screen.getByTestId('canvas-dirty-indicator')).toBeInTheDocument()
    expect(screen.getByTestId('canvas-dirty-indicator').textContent).toBe('unsaved')
  })

  it('does not show dirty indicator when clean', () => {
    render(<CanvasPanel />)
    expect(screen.queryByTestId('canvas-dirty-indicator')).not.toBeInTheDocument()
  })

  // -- Auto-save ------------------------------------------------------------

  it('triggers auto-save after 5 seconds when dirty', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ status: 'saved' }), { status: 200 }))
    useSessionStore.getState().setSession('test-sess', 'p1')

    render(<CanvasPanel />)

    // Wait for tldraw onMount
    await act(async () => { vi.advanceTimersByTime(10) })

    // Set dirty
    act(() => { useCanvasStore.getState().setDirty(true) })

    // Before 5s — no fetch
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
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ status: 'saved' }), { status: 200 }))
    useSessionStore.getState().setSession('sess-clean', 'p1')

    render(<CanvasPanel />)
    await act(async () => { vi.advanceTimersByTime(10) })
    act(() => { useCanvasStore.getState().setDirty(true) })
    await act(async () => { vi.advanceTimersByTime(5100) })

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

    // Let onMount + fetch resolve
    await act(async () => { vi.advanceTimersByTime(10) })
    // Wait for fetch promise to resolve
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })

    expect(fetchSpy).toHaveBeenCalledWith('/api/canvas/load-sess')
  })

  it('does not call load when sessionId is null', async () => {
    render(<CanvasPanel />)
    await act(async () => { vi.advanceTimersByTime(100) })

    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/canvas/'),
      // No method option means it's a GET
    )
  })

  it('handles load failure gracefully (non-ok response)', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 500 }))
    useSessionStore.getState().setSession('fail-sess', 'p1')

    // Should not throw
    render(<CanvasPanel />)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })

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

    render(<CanvasPanel />)

    // Wait for editor mount
    await act(async () => { vi.advanceTimersByTime(10) })

    const btn = screen.getByTestId('canvas-export-json')
    await user.click(btn)

    expect(createObjectURLSpy).toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalled()
    expect(revokeObjectURLSpy).toHaveBeenCalled()

    vi.restoreAllMocks()
  })

  // -- Pending shapes -------------------------------------------------------

  it('processes pending shapes into the editor', async () => {
    render(<CanvasPanel />)

    // Wait for editor mount
    await act(async () => { vi.advanceTimersByTime(10) })

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
})
