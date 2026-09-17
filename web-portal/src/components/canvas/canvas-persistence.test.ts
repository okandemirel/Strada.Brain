/**
 * Plan 2.6 (audit 11.3 / D33, Codex #25): what a canvas save means.
 * Before this, `fetch(...).then(() => setDirty(false))` treated a 500 and a
 * 409 as success, connections were never sent, and no version went with the
 * write.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  canvasSavePayload,
  parseCanvasConnections,
  readCanvasVersion,
  samePayload,
  saveCanvasState,
} from './canvas-persistence'
import type { ResolvedShape } from './canvas-types'

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
