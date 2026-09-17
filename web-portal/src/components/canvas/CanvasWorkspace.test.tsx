/**
 * CANVAS AUTO-SAVE — one writer, one queue, one session (round 9 #17-#20).
 *
 * The debounced save used to fire straight out of a React effect with the
 * version held in a ref:
 *   - two windows that both read `canvas: null` both wrote with no version at
 *     all, so the second silently destroyed the first (#17);
 *   - a second debounce fired while the first PUT was still in flight and sent
 *     the SAME stale version, so a window conflicted with itself (#18);
 *   - a connection drawn during a save scheduled nothing, because the effect's
 *     dependencies only listed `shapes` (#19);
 *   - a previous session's acknowledgement, or a slow first GET, overwrote the
 *     current session's version and shapes (#20).
 *
 * These tests drive the real component with a controllable fetch: every PUT is
 * held open until the test acknowledges it, which is the only way the ordering
 * above is observable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ children }: { children?: React.ReactNode }) => <div data-testid="react-flow">{children}</div>,
  ReactFlowProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  BackgroundVariant: { Dots: 'dots' },
  useReactFlow: () => ({
    fitView: vi.fn(),
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    screenToFlowPosition: (p: { x: number; y: number }) => p,
  }),
}))

vi.mock('../../hooks/use-canvas-bridge', () => ({
  useCanvasBridge: () => ({ nodes: [], edges: [], onNodesChange: vi.fn(), onEdgesChange: vi.fn() }),
  shapesToNodes: () => [],
  connectionsToEdges: () => [],
}))
vi.mock('../../hooks/use-canvas-shortcuts', () => ({ useCanvasShortcuts: () => {} }))
vi.mock('../../hooks/useWS', () => ({ useWS: () => ({ sendRawJSON: vi.fn() }) }))
vi.mock('./canvas-toolbar', () => ({ default: () => null }))
vi.mock('./canvas-context-menu', () => ({ default: () => null }))
vi.mock('./canvas-empty-state', () => ({ default: () => null }))
vi.mock('./BaseCard', () => ({ default: () => null }))
vi.mock('./GradientBezierEdge', () => ({ default: () => null }))

import CanvasWorkspace from './CanvasWorkspace'
import { useCanvasStore } from '../../stores/canvas-store'
import { useSessionStore } from '../../stores/session-store'
import type { ResolvedShape } from './canvas-types'

const SAVE_DEBOUNCE_MS = 5_000

const shape = (id: string): ResolvedShape => ({
  id, type: 'note-block', x: 0, y: 0, w: 220, h: 120, props: { content: id },
})

/** The same shape at a given position with given content — for r11 #9. */
const noteAt = (id: string, x: number, content: string): ResolvedShape => ({
  id, type: 'note-block', x, y: 0, w: 220, h: 120, props: { content },
})

/** A PUT held open until the test acknowledges it. */
interface HeldPut {
  url: string
  body: Record<string, unknown>
  ack: (init: { status?: number; version?: number }) => void
}

let puts: HeldPut[] = []
/** GET body per session id; a missing entry means "the request never settles". */
let gets: Map<string, { canvas: unknown } | null>
/** GET status per session id when the read must FAIL (r10 #9). */
let getStatus: Map<string, number>
/** Every session id that has been read, in order — retries are visible here. */
let getCalls: string[]
let pendingGets: Array<(body: { canvas: unknown } | null) => void>

function installFetch(): void {
  puts = []
  pendingGets = []
  getCalls = []
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method === 'GET') {
      const sessionId = decodeURIComponent(url.replace('/api/canvas/', ''))
      getCalls.push(sessionId)
      const failure = getStatus.get(sessionId)
      if (failure !== undefined) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'nope' }), { status: failure }))
      }
      const body = gets.get(sessionId)
      if (body === undefined) {
        // Held open: the test resolves it when it wants the load to land.
        return new Promise<Response>((resolve) => {
          pendingGets.push((late) => resolve(new Response(JSON.stringify(late), { status: 200 })))
        })
      }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
    }
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>
    return new Promise<Response>((resolve) => {
      puts.push({
        url,
        body,
        ack: ({ status = 200, version }) =>
          resolve(new Response(JSON.stringify({ status: 'saved', sessionId: 'x', version }), { status })),
      })
    })
  }) as unknown as typeof fetch
}

/** Let the debounce fire and every settled promise run. */
async function tick(ms = SAVE_DEBOUNCE_MS): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** Run a store mutation the way a user edit does. */
async function edit(mutate: () => void): Promise<void> {
  await act(async () => {
    mutate()
    useCanvasStore.getState().setDirty(true)
  })
}

const canvasVersion = (v: number, shapes: ResolvedShape[] = [], connections: unknown[] = []) => ({
  canvas: {
    id: 's', sessionId: 's',
    shapes: JSON.stringify(shapes),
    connections: JSON.stringify(connections),
    viewport: JSON.stringify({ x: 0, y: 0, zoom: 1 }),
    version: v,
    createdAt: 1, updatedAt: 1,
  },
})

describe('CanvasWorkspace auto-save', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    gets = new Map()
    getStatus = new Map()
    installFetch()
    useCanvasStore.setState({
      sessionId: null,
      isDirty: false,
      shapes: [],
      connections: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      pendingShapes: [],
      pendingUpdates: [],
      pendingRemovals: [],
      pendingViewport: null,
      pendingLayout: null,
      undoStack: [],
      redoStack: [],
    })
    useSessionStore.setState({ sessionId: 'sess-a' })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // -- #17 -------------------------------------------------------------------

  it('creates a canvas the server reported absent with the create-if-absent precondition', async () => {
    // Both windows read `canvas: null`. Writing with no version at all made
    // both writes unconditional, and the second destroyed the first (#17).
    gets.set('sess-a', { canvas: null })
    render(<CanvasWorkspace />)
    await tick(0)

    await edit(() => useCanvasStore.getState().addShape(shape('s1')))
    await tick()

    expect(puts).toHaveLength(1)
    expect(puts[0]!.body.version).toBe(0)
  })

  // -- #18 -------------------------------------------------------------------

  it('holds a second revision until the first save is acked, then sends it against the acked version', async () => {
    gets.set('sess-a', canvasVersion(5, [shape('s1')]))
    render(<CanvasWorkspace />)
    await tick(0)

    await edit(() => useCanvasStore.getState().addShape(shape('s2')))
    await tick()
    expect(puts).toHaveLength(1)
    expect(puts[0]!.body.version).toBe(5)

    // An edit while the first PUT is still open: it must NOT go out with the
    // same version 5 — that is a window conflicting with itself.
    await edit(() => useCanvasStore.getState().addShape(shape('s3')))
    await tick()
    expect(puts).toHaveLength(1)

    await act(async () => { puts[0]!.ack({ version: 6 }) })
    await tick()

    expect(puts).toHaveLength(2)
    expect(puts[1]!.body.version).toBe(6)
    expect(JSON.parse(String(puts[1]!.body.shapes)).map((s: ResolvedShape) => s.id)).toEqual(['s1', 's2', 's3'])
    expect(screen.queryByText('panel.saveConflict')).toBeNull()

    await act(async () => { puts[1]!.ack({ version: 7 }) })
    await tick(0)
    expect(useCanvasStore.getState().isDirty).toBe(false)
  })

  // -- #19 -------------------------------------------------------------------

  it('sends a connection drawn while a save was in flight', async () => {
    gets.set('sess-a', canvasVersion(5, [shape('s1')]))
    render(<CanvasWorkspace />)
    await tick(0)

    await edit(() => useCanvasStore.getState().addShape(shape('s2')))
    await tick()
    expect(puts).toHaveLength(1)

    // isDirty is already true and `shapes` does not change: the old effect had
    // nothing to re-run on, so this connection was never saved (#19).
    await edit(() => useCanvasStore.getState().addConnection({ id: 'c1', from: 's1', to: 's2' }))
    await act(async () => { puts[0]!.ack({ version: 6 }) })
    await tick()

    expect(puts).toHaveLength(2)
    expect(JSON.parse(String(puts[1]!.body.connections))).toEqual([{ id: 'c1', from: 's1', to: 's2' }])
    expect(puts[1]!.body.version).toBe(6)
  })

  it('schedules a save for a connection drawn while the canvas was already dirty', async () => {
    gets.set('sess-a', canvasVersion(5, [shape('s1'), shape('s2')]))
    render(<CanvasWorkspace />)
    await tick(0)

    // A failed save leaves the canvas dirty. The connection drawn next is the
    // only thing that changes — no shape, no dirty transition — and the old
    // effect watched neither, so nothing was ever sent (#19).
    await edit(() => useCanvasStore.getState().addShape(shape('s3')))
    await tick()
    await act(async () => { puts[0]!.ack({ status: 500 }) })
    await tick(0)

    await edit(() => useCanvasStore.getState().addConnection({ id: 'c9', from: 's1', to: 's2' }))
    await tick()

    expect(puts).toHaveLength(2)
    expect(JSON.parse(String(puts[1]!.body.connections))).toEqual([{ id: 'c9', from: 's1', to: 's2' }])
  })

  // -- #20 -------------------------------------------------------------------

  it('ignores an acknowledgement that belongs to the previous session', async () => {
    gets.set('sess-a', canvasVersion(5, [shape('s1')]))
    gets.set('sess-b', canvasVersion(2, [shape('b1')]))
    render(<CanvasWorkspace />)
    await tick(0)

    await edit(() => useCanvasStore.getState().addShape(shape('s2')))
    await tick()
    expect(puts).toHaveLength(1)
    expect(puts[0]!.url).toBe('/api/canvas/sess-a')

    await act(async () => { useSessionStore.setState({ sessionId: 'sess-b' }) })
    await tick(0)
    expect(useCanvasStore.getState().shapes.map((s) => s.id)).toEqual(['b1'])

    // Session A's ack lands late. It must not become session B's version.
    await act(async () => { puts[0]!.ack({ version: 8 }) })
    await tick(0)

    await edit(() => useCanvasStore.getState().addShape(shape('b2')))
    await tick()

    const last = puts[puts.length - 1]!
    expect(last.url).toBe('/api/canvas/sess-b')
    expect(last.body.version).toBe(2)
    expect(screen.queryByText('panel.saveConflict')).toBeNull()
  })

  it('replays the work done during a slow load onto the canvas the load returned (r10 #10)', async () => {
    // The version the load reported used to be adopted while its CONTENT was
    // dropped, so the next save wrote the local shapes alone against that
    // version — a conditional write that deleted the server's canvas.
    render(<CanvasWorkspace />)
    await tick(0)
    expect(pendingGets).toHaveLength(1)

    // The user (or an agent) draws while the GET is still open.
    await edit(() => useCanvasStore.getState().addShape(shape('local')))
    await edit(() => useCanvasStore.getState().addConnection({ id: 'c-local', from: 'local', to: 'local' }))
    await act(async () => {
      pendingGets[0]!(canvasVersion(
        3,
        [shape('from-server')],
        [{ id: 'c-server', from: 'from-server', to: 'from-server' }],
      ))
    })
    await tick(0)

    // Both survive: the canvas the version belongs to AND the new work.
    expect(useCanvasStore.getState().shapes.map((s) => s.id)).toEqual(['from-server', 'local'])
    expect(useCanvasStore.getState().connections.map((c) => c.id)).toEqual(['c-server', 'c-local'])
    expect(useCanvasStore.getState().isDirty).toBe(true)

    // …and the save against version 3 sends the merged canvas, not just the edit.
    await tick()
    expect(puts).toHaveLength(1)
    expect(puts[0]!.body.version).toBe(3)
    expect(JSON.parse(String(puts[0]!.body.shapes)).map((s: ResolvedShape) => s.id))
      .toEqual(['from-server', 'local'])
    expect(JSON.parse(String(puts[0]!.body.connections)).map((c: { id: string }) => c.id))
      .toEqual(['c-server', 'c-local'])
  })

  it('never writes a session before its canvas has been read', async () => {
    gets.set('sess-a', canvasVersion(5, [shape('s1')]))
    render(<CanvasWorkspace />)
    await tick(0)

    // Switch to a session whose GET never settles. The store still holds the
    // previous session's shapes, so writing now would overwrite the new
    // session's canvas with them — under a version from the old one (#20).
    await act(async () => { useSessionStore.setState({ sessionId: 'sess-slow' }) })
    await tick(0)
    await edit(() => useCanvasStore.getState().addShape(shape('s2')))
    await tick()
    expect(puts).toHaveLength(0)

    // Once the read lands, the edit goes out against the version it reported.
    await act(async () => { pendingGets[0]!(canvasVersion(7, [shape('remote')])) })
    await tick()
    expect(puts).toHaveLength(1)
    expect(puts[0]!.url).toBe('/api/canvas/sess-slow')
    expect(puts[0]!.body.version).toBe(7)
  })

  // -- r10 #8 ----------------------------------------------------------------

  it('writes nothing when a save is acked after the workspace unmounted and the session moved on (#8)', async () => {
    gets.set('sess-a', canvasVersion(5, [shape('s1')]))
    const view = render(<CanvasWorkspace />)
    await tick(0)

    await edit(() => useCanvasStore.getState().addShape(shape('s2')))
    await tick()
    expect(puts).toHaveLength(1)
    expect(puts[0]!.url).toBe('/api/canvas/sess-a')

    // The workspace closes with the PUT still open and the store is pointed at
    // another session's canvas. Disposal used to cancel only the debounce, so
    // the acknowledgement read THAT canvas and addressed a second PUT to sess-a.
    await act(async () => { view.unmount() })
    await act(async () => {
      useSessionStore.setState({ sessionId: 'sess-b' })
      useCanvasStore.setState({ shapes: [shape('b1')], connections: [], isDirty: true })
    })

    await act(async () => { puts[0]!.ack({ version: 6 }) })
    await tick()

    expect(puts).toHaveLength(1)
    expect(useCanvasStore.getState().shapes.map((s) => s.id)).toEqual(['b1'])
    // The other session's canvas is untouched, and still unsaved by us.
    expect(useCanvasStore.getState().isDirty).toBe(true)
  })

  // -- r10 #9 ----------------------------------------------------------------

  it('never writes without a precondition after a failed load (#9)', async () => {
    // The server holds version 7; the GET fails. A write with no version is an
    // unconditional upsert: it would destroy version 7 with no conflict.
    getStatus.set('sess-a', 500)
    render(<CanvasWorkspace />)
    await tick(0)

    await edit(() => useCanvasStore.getState().addShape(shape('s1')))
    await tick()
    expect(puts).toHaveLength(0)

    // Retries keep failing: still no write, and the work is not lost.
    await tick(60_000)
    expect(puts).toHaveLength(0)
    expect(getCalls.filter((s) => s === 'sess-a').length).toBeGreaterThan(1)
    expect(useCanvasStore.getState().shapes.map((s) => s.id)).toEqual(['s1'])
    expect(useCanvasStore.getState().isDirty).toBe(true)
  })

  it('saves the work done during a failed load once a retry reads the canvas (#9 guard)', async () => {
    getStatus.set('sess-a', 503)
    render(<CanvasWorkspace />)
    await tick(0)

    await edit(() => useCanvasStore.getState().addShape(shape('local')))
    await tick()
    expect(puts).toHaveLength(0)

    // The server recovers before the retry.
    getStatus.delete('sess-a')
    gets.set('sess-a', canvasVersion(7, [shape('from-server')]))
    await tick(2_000)
    await tick()

    expect(puts).toHaveLength(1)
    expect(puts[0]!.body.version).toBe(7)
    expect(JSON.parse(String(puts[0]!.body.shapes)).map((s: ResolvedShape) => s.id))
      .toEqual(['from-server', 'local'])
  })

  it('tells the person once the canvas cannot be read at all, and stops saying it when a read lands', async () => {
    // Writes stay blocked after a failed read (#9) — which, said by nothing at
    // all, looked exactly like a canvas that was being saved.
    getStatus.set('sess-a', 500)
    render(<CanvasWorkspace />)
    await tick(0)
    // Not while retries are still coming.
    expect(screen.queryByText('panel.loadFailed')).toBeNull()
    await tick(2_000); await tick(4_000); await tick(8_000); await tick(16_000)
    await tick()
    expect(screen.getByText('panel.loadFailed')).toBeTruthy()

    // …and it goes away when a read finally lands (guard).
    getStatus.delete('sess-a')
    gets.set('sess-a', canvasVersion(3, [shape('from-server')]))
    await act(async () => { useSessionStore.setState({ sessionId: 'sess-b' } as never) })
    gets.set('sess-b', canvasVersion(4, [shape('other')]))
    await tick(0)
    expect(screen.queryByText('panel.loadFailed')).toBeNull()
  })

  it('treats a canvas whose version cannot be read as unread (#9 guard)', async () => {
    // A row without a usable version cannot be written conditionally at all.
    gets.set('sess-a', { canvas: { shapes: JSON.stringify([shape('s1')]), connections: '[]', viewport: '{}' } })
    render(<CanvasWorkspace />)
    await tick(0)

    await edit(() => useCanvasStore.getState().addShape(shape('s2')))
    await tick(60_000)
    expect(puts).toHaveLength(0)
  })

  // -- guards ----------------------------------------------------------------

  it('saves, clears dirty and follows the version the server acked (guard)', async () => {
    gets.set('sess-a', canvasVersion(5, [shape('s1')]))
    render(<CanvasWorkspace />)
    await tick(0)

    await edit(() => useCanvasStore.getState().addShape(shape('s2')))
    await tick()
    expect(puts[0]!.body.version).toBe(5)
    expect(JSON.parse(String(puts[0]!.body.shapes)).map((s: ResolvedShape) => s.id)).toEqual(['s1', 's2'])

    await act(async () => { puts[0]!.ack({ version: 6 }) })
    await tick(0)
    expect(useCanvasStore.getState().isDirty).toBe(false)
    expect(screen.queryByText('panel.saveConflict')).toBeNull()

    await edit(() => useCanvasStore.getState().addShape(shape('s3')))
    await tick()
    expect(puts).toHaveLength(2)
    expect(puts[1]!.body.version).toBe(6)
  })

  it('surfaces a 409 and keeps the work dirty (guard)', async () => {
    gets.set('sess-a', canvasVersion(5, [shape('s1')]))
    render(<CanvasWorkspace />)
    await tick(0)

    await edit(() => useCanvasStore.getState().addShape(shape('s2')))
    await tick()
    await act(async () => { puts[0]!.ack({ status: 409 }) })
    await tick(0)

    expect(screen.getByText('panel.saveConflict')).toBeTruthy()
    expect(useCanvasStore.getState().isDirty).toBe(true)
  })

  // -- r11 #9 ----------------------------------------------------------------

  it('keeps a remote label edit AND a local move made during the same read (r11 #9)', async () => {
    // The replay took the whole LOCAL object for a shape both sides hold, so the
    // label the server had gained was replaced by the stale local one — and the
    // versioned PUT then destroyed it on the server too.
    useCanvasStore.setState({ shapes: [noteAt('s1', 0, 'old')], connections: [] })
    render(<CanvasWorkspace />)
    await tick(0)
    expect(pendingGets).toHaveLength(1)

    // The user drags the shape while the GET is open…
    await edit(() => useCanvasStore.getState().updateShape('s1', { x: 200 }))
    // …and the canvas the read returns has a new label for it.
    await act(async () => { pendingGets[0]!(canvasVersion(3, [noteAt('s1', 0, 'server')])) })
    await tick(0)

    const merged = useCanvasStore.getState().shapes
    expect(merged).toHaveLength(1)
    expect(merged[0]!.x).toBe(200)
    expect(merged[0]!.props.content).toBe('server')
    expect(screen.queryByText('panel.saveConflict')).toBeNull()

    // …and that is what is written back against the version the read reported.
    await tick()
    expect(puts).toHaveLength(1)
    expect(puts[0]!.body.version).toBe(3)
    const sent = JSON.parse(String(puts[0]!.body.shapes)) as ResolvedShape[]
    expect(sent[0]!.x).toBe(200)
    expect(sent[0]!.props.content).toBe('server')
  })

  it('surfaces a conflict when the read and the user changed the SAME property (r11 #9)', async () => {
    useCanvasStore.setState({ shapes: [noteAt('s1', 0, 'old')], connections: [] })
    render(<CanvasWorkspace />)
    await tick(0)

    await edit(() => useCanvasStore.getState().updateShape('s1', { props: { content: 'mine' } }))
    await act(async () => { pendingGets[0]!(canvasVersion(3, [noteAt('s1', 0, 'theirs')])) })
    await tick(0)

    // The person's own text stays in front of them, and they are told the server
    // held something else — the one thing that must not happen is silence.
    expect(useCanvasStore.getState().shapes[0]!.props.content).toBe('mine')
    expect(screen.getByText('panel.saveConflict')).toBeTruthy()
  })

  it('keeps a remote edit to a connection label while a local one is redrawn (r11 #9)', async () => {
    useCanvasStore.setState({
      shapes: [],
      connections: [{ id: 'c1', from: 'a', to: 'b', label: 'old' }],
    })
    render(<CanvasWorkspace />)
    await tick(0)

    await edit(() => useCanvasStore.setState({
      connections: [{ id: 'c1', from: 'a', to: 'z', label: 'old' }],
    }))
    await act(async () => {
      pendingGets[0]!(canvasVersion(4, [], [{ id: 'c1', from: 'a', to: 'b', label: 'server' }]))
    })
    await tick(0)

    expect(useCanvasStore.getState().connections).toEqual([
      { id: 'c1', from: 'a', to: 'z', label: 'server' },
    ])
  })

  // -- r11 #10 ---------------------------------------------------------------

  it('clears the previous session\'s shapes when the new canvas is stored EMPTY (r11 #10)', async () => {
    // An empty saved canvas parsed as "nothing usable", which left the previous
    // session's shapes in the store — and the next save wrote them into B.
    gets.set('sess-a', canvasVersion(5, [shape('a1')]))
    gets.set('sess-b', canvasVersion(2, []))
    render(<CanvasWorkspace />)
    await tick(0)
    expect(useCanvasStore.getState().shapes.map((s) => s.id)).toEqual(['a1'])

    await act(async () => { useSessionStore.setState({ sessionId: 'sess-b' }) })
    await tick(0)
    expect(useCanvasStore.getState().shapes).toEqual([])
  })

  it('saves only the shape drawn while an EMPTY canvas was loading (r11 #10)', async () => {
    // The previous session left 'a' in the store; B's read is slow and returns
    // an empty canvas. Only 'b' — the work done here — belongs to B.
    useCanvasStore.setState({ shapes: [shape('a')], connections: [] })
    render(<CanvasWorkspace />)
    await tick(0)
    expect(pendingGets).toHaveLength(1)

    await edit(() => useCanvasStore.getState().addShape(shape('b')))
    await act(async () => { pendingGets[0]!(canvasVersion(2, [])) })
    await tick(0)
    expect(useCanvasStore.getState().shapes.map((s) => s.id)).toEqual(['b'])

    await tick()
    expect(puts).toHaveLength(1)
    expect(puts[0]!.body.version).toBe(2)
    expect(JSON.parse(String(puts[0]!.body.shapes)).map((s: ResolvedShape) => s.id)).toEqual(['b'])
  })

  it('leaves the canvas alone when the stored shapes cannot be read (r11 #10 guard)', async () => {
    // Unreadable is NOT empty: a row we cannot parse must not clear the canvas.
    gets.set('sess-a', canvasVersion(5, [shape('a1')]))
    render(<CanvasWorkspace />)
    await tick(0)

    gets.set('sess-b', {
      canvas: { shapes: 'not json at all', connections: '[]', viewport: '{}', version: 2 },
    })
    await act(async () => { useSessionStore.setState({ sessionId: 'sess-b' }) })
    await tick(0)
    expect(useCanvasStore.getState().shapes.map((s) => s.id)).toEqual(['a1'])
  })

  it('keeps the work dirty when the save fails, and retries on the next edit (guard)', async () => {
    gets.set('sess-a', canvasVersion(5, [shape('s1')]))
    render(<CanvasWorkspace />)
    await tick(0)

    await edit(() => useCanvasStore.getState().addShape(shape('s2')))
    await tick()
    await act(async () => { puts[0]!.ack({ status: 500 }) })
    await tick(0)
    expect(useCanvasStore.getState().isDirty).toBe(true)

    await edit(() => useCanvasStore.getState().addShape(shape('s3')))
    await tick()
    expect(puts).toHaveLength(2)
    expect(puts[1]!.body.version).toBe(5) // nothing was stored, so the version stands
  })
})
