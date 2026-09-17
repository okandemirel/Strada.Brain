/**
 * Plan 2.6 (audit 11.3 / D33, Codex #25): what a canvas save means.
 * Before this, `fetch(...).then(() => setDirty(false))` treated a 500 and a
 * 409 as success, connections were never sent, and no version went with the
 * write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CanvasSaveScheduler,
  canvasSavePayload,
  parseCanvasConnections,
  readCanvasVersion,
  samePayload,
  saveCanvasState,
} from './canvas-persistence'
import type { CanvasSavePayload, CanvasSaveResult } from './canvas-persistence'
import type { CanvasConnection, ResolvedShape } from './canvas-types'

const shape = (id: string): ResolvedShape => ({ id, type: 'note-block', x: 0, y: 0, w: 10, h: 10, props: {} })

function fetchReturning(status: number, body: unknown = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

describe('saveCanvasState', () => {
  it('sends shapes, connections and the held version, and reports the version the server acked', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init!.body)) as Record<string, unknown> })
      return new Response(JSON.stringify({ status: 'saved', version: 7 }), { status: 200 })
    }) as unknown as typeof fetch

    const payload = canvasSavePayload([shape('s1')], [{ id: 'c1', from: 's1', to: 's2' }], { x: 1, y: 2, zoom: 1 })
    const result = await saveCanvasState({ sessionId: 'sess a', payload, version: 6, fetchImpl })

    expect(result).toEqual({ kind: 'saved', version: 7 })
    expect(calls[0]!.url).toBe('/api/canvas/sess%20a')
    // Connections used to be dropped entirely, so every reload lost the arrows.
    expect(JSON.parse(String(calls[0]!.body.connections))).toEqual([{ id: 'c1', from: 's1', to: 's2' }])
    expect(calls[0]!.body.version).toBe(6)
  })

  it('reports a 409 as a conflict, never as a save', async () => {
    const result = await saveCanvasState({
      sessionId: 's', payload: canvasSavePayload([], [], null), version: 3,
      fetchImpl: fetchReturning(409, { error: 'Version conflict' }),
    })
    expect(result).toEqual({ kind: 'conflict' })
  })

  it('reports a server error and a network failure as failures, so the work stays dirty', async () => {
    expect(await saveCanvasState({
      sessionId: 's', payload: canvasSavePayload([], [], null), fetchImpl: fetchReturning(500),
    })).toEqual({ kind: 'failed', status: 500 })

    const offline = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await saveCanvasState({
      sessionId: 's', payload: canvasSavePayload([], [], null), fetchImpl: offline,
    })).toEqual({ kind: 'failed', status: null })
  })

  it('omits the version on a first save and still reports one back', async () => {
    const seen: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init!.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ status: 'saved' }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await saveCanvasState({ sessionId: 's', payload: canvasSavePayload([], [], null), fetchImpl })
    expect('version' in seen[0]!).toBe(false)
    expect(result).toEqual({ kind: 'saved', version: 1 })
  })
})

describe('samePayload (the acked revision)', () => {
  it('is false when anything changed while the request was in flight', () => {
    const sent = canvasSavePayload([shape('s1')], [], { x: 0, y: 0, zoom: 1 })
    expect(samePayload(sent, canvasSavePayload([shape('s1')], [], { x: 0, y: 0, zoom: 1 }))).toBe(true)
    // A shape added during the save: clearing dirty here would lose it.
    expect(samePayload(sent, canvasSavePayload([shape('s1'), shape('s2')], [], { x: 0, y: 0, zoom: 1 }))).toBe(false)
    // …and so would a connection drawn during the save.
    expect(samePayload(sent, canvasSavePayload([shape('s1')], [{ id: 'c', from: 's1', to: 's1' }], { x: 0, y: 0, zoom: 1 }))).toBe(false)
    expect(samePayload(sent, canvasSavePayload([shape('s1')], [], { x: 5, y: 0, zoom: 1 }))).toBe(false)
  })
})

describe('readCanvasVersion / parseCanvasConnections', () => {
  it('takes a positive number only', () => {
    expect(readCanvasVersion({ version: 4 })).toBe(4)
    expect(readCanvasVersion({ version: 0 })).toBeUndefined()
    expect(readCanvasVersion({ version: '4' })).toBeUndefined()
    expect(readCanvasVersion(null)).toBeUndefined()
  })

  it('keeps well-formed connections and drops the rest, from a string or an array', () => {
    const raw = JSON.stringify([
      { id: 'c1', from: 'a', to: 'b', label: 'calls' },
      { id: 'c2', from: 'a' },
      { from: 'a', to: 'b' },
      'nope',
    ])
    expect(parseCanvasConnections(raw)).toEqual([{ id: 'c1', from: 'a', to: 'b', label: 'calls' }])
    expect(parseCanvasConnections([{ id: 'c3', from: 'x', to: 'y' }])).toEqual([{ id: 'c3', from: 'x', to: 'y' }])
    expect(parseCanvasConnections('not json')).toEqual([])
    expect(parseCanvasConnections(undefined)).toEqual([])
  })
})

describe('saveCanvasState preconditions (r9 #17)', () => {
  it("sends version 0 for an absent canvas — a create, not an unconditional write", async () => {
    // Two windows that both read `canvas: null` used to send no version at
    // all, so both writes were unconditional upserts and the second destroyed
    // the first window's work.
    const seen: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init!.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ status: 'saved', version: 1 }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await saveCanvasState({
      sessionId: 's', payload: canvasSavePayload([], [], null), version: 'absent', fetchImpl,
    })
    expect(seen[0]!.version).toBe(0)
    expect(result).toEqual({ kind: 'saved', version: 1 })
  })

  it('still sends no version at all when it does not know one (guard)', async () => {
    const seen: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init!.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ status: 'saved' }), { status: 200 })
    }) as unknown as typeof fetch
    await saveCanvasState({ sessionId: 's', payload: canvasSavePayload([], [], null), fetchImpl })
    expect('version' in seen[0]!).toBe(false)
  })
})

describe('CanvasSaveScheduler', () => {
  /** A save that is only answered when the test says so. */
  function harness(revision: { shapes: ResolvedShape[]; connections: CanvasConnection[] }) {
    const sent: Array<{ payload: CanvasSavePayload; version: unknown; settle: (r: CanvasSaveResult) => void }> = []
    const saved: Array<{ version: number; upToDate: boolean }> = []
    const conflicts: number[] = []
    const failures: Array<number | null> = []
    const scheduler = new CanvasSaveScheduler({
      debounceMs: 10,
      readRevision: () => canvasSavePayload(revision.shapes, revision.connections, { x: 0, y: 0, zoom: 1 }),
      save: ({ payload, version }) =>
        new Promise<CanvasSaveResult>((resolve) => { sent.push({ payload, version, settle: resolve }) }),
      onSaved: (info) => { saved.push(info) },
      onConflict: () => { conflicts.push(1) },
      onFailed: (status) => { failures.push(status) },
    })
    return { scheduler, sent, saved, conflicts, failures }
  }

  const shapeOf = (id: string): ResolvedShape => ({ id, type: 'note-block', x: 0, y: 0, w: 10, h: 10, props: {} })
  /** Let a settled save's continuation and the debounce run. */
  const settleAll = async () => { await vi.advanceTimersByTimeAsync(20) }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it("writes nothing until the session's canvas has been read (#20)", async () => {
    const revision = { shapes: [shapeOf('a')], connections: [] as CanvasConnection[] }
    const { scheduler, sent } = harness(revision)
    const generation = scheduler.startSession('s1')

    scheduler.requestSave()
    await settleAll()
    expect(sent).toHaveLength(0)

    scheduler.adoptVersion(4, generation)
    scheduler.finishLoad(generation)
    await settleAll()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.version).toBe(4)
  })

  it('serializes saves and sends the queued revision against the acked version (#18)', async () => {
    const revision = { shapes: [shapeOf('a')], connections: [] as CanvasConnection[] }
    const { scheduler, sent, saved, conflicts } = harness(revision)
    const generation = scheduler.startSession('s1')
    scheduler.adoptVersion(5, generation)
    scheduler.finishLoad(generation)

    scheduler.requestSave()
    await settleAll()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.version).toBe(5)

    // An edit while the first PUT is open must not reuse version 5.
    revision.shapes = [shapeOf('a'), shapeOf('b')]
    scheduler.requestSave()
    await settleAll()
    expect(sent).toHaveLength(1)

    sent[0]!.settle({ kind: 'saved', version: 6 })
    await settleAll()
    expect(sent).toHaveLength(2)
    expect(sent[1]!.version).toBe(6)
    expect(JSON.parse(sent[1]!.payload.shapes).map((s: ResolvedShape) => s.id)).toEqual(['a', 'b'])
    expect(saved).toEqual([{ version: 6, upToDate: false }])
    expect(conflicts).toHaveLength(0)
  })

  it('drains a change made during a save even when nothing asked for it (#19)', async () => {
    const revision = { shapes: [shapeOf('a')], connections: [] as CanvasConnection[] }
    const { scheduler, sent, saved } = harness(revision)
    const generation = scheduler.startSession('s1')
    scheduler.adoptVersion(5, generation)
    scheduler.finishLoad(generation)
    scheduler.requestSave()
    await settleAll()

    // A connection drawn while the PUT was open: no further requestSave.
    revision.connections = [{ id: 'c1', from: 'a', to: 'b' }]
    sent[0]!.settle({ kind: 'saved', version: 6 })
    await settleAll()

    expect(sent).toHaveLength(2)
    expect(JSON.parse(sent[1]!.payload.connections)).toEqual([{ id: 'c1', from: 'a', to: 'b' }])
    expect(saved[0]!.upToDate).toBe(false)
  })

  it('ignores a result that belongs to a previous session (#20)', async () => {
    const revision = { shapes: [shapeOf('a')], connections: [] as CanvasConnection[] }
    const { scheduler, sent, saved, conflicts, failures } = harness(revision)
    const genA = scheduler.startSession('s1')
    scheduler.adoptVersion(5, genA)
    scheduler.finishLoad(genA)
    scheduler.requestSave()
    await settleAll()
    expect(sent).toHaveLength(1)

    const genB = scheduler.startSession('s2')
    scheduler.adoptVersion(2, genB)
    scheduler.finishLoad(genB)

    sent[0]!.settle({ kind: 'saved', version: 8 })
    await settleAll()
    expect(saved).toHaveLength(0)
    expect(conflicts).toHaveLength(0)
    expect(failures).toHaveLength(0)
    expect(scheduler.precondition).toBe(2)

    scheduler.requestSave()
    await settleAll()
    expect(sent).toHaveLength(2)
    expect(sent[1]!.version).toBe(2)
  })

  it("refuses a load's content once the canvas has been edited or saved, but takes its version (#20)", async () => {
    const revision = { shapes: [shapeOf('a')], connections: [] as CanvasConnection[] }
    const { scheduler, sent } = harness(revision)
    const generation = scheduler.startSession('s1')
    expect(scheduler.canApplyContent(generation)).toBe(true)

    scheduler.requestSave() // the user edited while the GET was open
    expect(scheduler.canApplyContent(generation)).toBe(false)
    scheduler.adoptVersion(3, generation)
    expect(scheduler.precondition).toBe(3)

    scheduler.finishLoad(generation)
    await settleAll()
    expect(sent[0]!.version).toBe(3)

    sent[0]!.settle({ kind: 'saved', version: 4 })
    await settleAll()
    // A GET issued before that save landed is now older than the canvas.
    expect(scheduler.canApplyContent(generation)).toBe(false)
    scheduler.adoptVersion(3, generation)
    expect(scheduler.precondition).toBe(4)
    // …and a stale generation is refused outright.
    expect(scheduler.canApplyContent(generation - 1)).toBe(false)
  })

  it('keeps the version and reports a conflict without queueing a retry (guard)', async () => {
    const revision = { shapes: [shapeOf('a')], connections: [] as CanvasConnection[] }
    const { scheduler, sent, conflicts, saved } = harness(revision)
    const generation = scheduler.startSession('s1')
    scheduler.adoptVersion(5, generation)
    scheduler.finishLoad(generation)
    scheduler.requestSave()
    await settleAll()

    sent[0]!.settle({ kind: 'conflict' })
    await settleAll()
    expect(conflicts).toHaveLength(1)
    expect(saved).toHaveLength(0)
    expect(sent).toHaveLength(1)
    expect(scheduler.precondition).toBe(5)
  })

  it('saves an unchanged revision exactly once and reports it clean (guard)', async () => {
    const revision = { shapes: [shapeOf('a')], connections: [] as CanvasConnection[] }
    const { scheduler, sent, saved } = harness(revision)
    const generation = scheduler.startSession('s1')
    scheduler.adoptVersion('absent', generation)
    scheduler.finishLoad(generation)
    scheduler.requestSave()
    scheduler.requestSave() // debounced: still one write
    await settleAll()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.version).toBe('absent')

    sent[0]!.settle({ kind: 'saved', version: 1 })
    await settleAll()
    expect(saved).toEqual([{ version: 1, upToDate: true }])
    expect(sent).toHaveLength(1)
    expect(scheduler.precondition).toBe(1)
  })

  it('reports a failure and writes nothing more on its own (guard)', async () => {
    const revision = { shapes: [shapeOf('a')], connections: [] as CanvasConnection[] }
    const { scheduler, sent, failures } = harness(revision)
    const generation = scheduler.startSession('s1')
    scheduler.adoptVersion(5, generation)
    scheduler.finishLoad(generation)
    scheduler.requestSave()
    await settleAll()

    sent[0]!.settle({ kind: 'failed', status: 500 })
    await settleAll()
    expect(failures).toEqual([500])
    expect(sent).toHaveLength(1)
    expect(scheduler.precondition).toBe(5)

    // The next edit retries, still against version 5: nothing was stored.
    revision.shapes = [shapeOf('a'), shapeOf('b')]
    scheduler.requestSave()
    await settleAll()
    expect(sent).toHaveLength(2)
    expect(sent[1]!.version).toBe(5)
  })

  it('stops the debounce on dispose (guard)', async () => {
    const revision = { shapes: [shapeOf('a')], connections: [] as CanvasConnection[] }
    const { scheduler, sent } = harness(revision)
    const generation = scheduler.startSession('s1')
    scheduler.finishLoad(generation)
    scheduler.requestSave()
    scheduler.dispose()
    await settleAll()
    expect(sent).toHaveLength(0)
  })
})
