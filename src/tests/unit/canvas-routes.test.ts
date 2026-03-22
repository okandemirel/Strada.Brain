import { describe, it, expect, beforeEach } from 'vitest'
import { Readable, Writable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import Database from 'better-sqlite3'
import { CanvasStorage } from '../../dashboard/canvas-storage.js'
import { handleCanvasRoute } from '../../dashboard/canvas-routes.js'

// ---------------------------------------------------------------------------
// Helpers (same pattern as monitor-routes.test.ts)
// ---------------------------------------------------------------------------

function fakeReq(method: string, body?: Record<string, unknown>): IncomingMessage {
  const readable = new Readable({
    read() {
      if (body) {
        this.push(JSON.stringify(body))
      }
      this.push(null)
    },
  })
  ;(readable as any).method = method
  return readable as unknown as IncomingMessage
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
  const chunks: Buffer[] = []
  let status = 0

  const writable = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk))
      cb()
    },
  }) as any

  writable._status = 0
  writable._body = ''
  writable.writeHead = (s: number, _headers?: Record<string, string>) => {
    status = s
    writable._status = s
  }
  writable.end = (data?: string | Buffer) => {
    if (data) chunks.push(Buffer.from(data))
    writable._body = Buffer.concat(chunks).toString()
    writable._status = status
  }

  return writable as ServerResponse & { _status: number; _body: string }
}

/** Small pause to let async readJsonBody resolve */
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleCanvasRoute', () => {
  let db: Database.Database
  let storage: CanvasStorage

  beforeEach(() => {
    db = new Database(':memory:')
    storage = new CanvasStorage(db)
  })

  // -- Routing fallthrough --------------------------------------------------

  it('returns false for non-canvas routes', () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    expect(handleCanvasRoute('/api/config', 'GET', req, res, storage)).toBe(false)
  })

  it('returns 503 when canvasStorage is undefined', () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    const handled = handleCanvasRoute('/api/canvas/sess-1', 'GET', req, res, undefined)
    expect(handled).toBe(true)
    expect(res._status).toBe(503)
    expect(JSON.parse(res._body).error).toContain('not available')
  })

  // -- GET /api/canvas/:sessionId -------------------------------------------

  it('GET returns null canvas for missing session', () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    handleCanvasRoute('/api/canvas/sess-1', 'GET', req, res, storage)
    expect(res._status).toBe(200)
    expect(JSON.parse(res._body)).toEqual({ canvas: null })
  })

  it('GET returns canvas state when present', () => {
    const now = Date.now()
    storage.save({
      id: 'c1',
      sessionId: 'sess-1',
      shapes: '[{"type":"rect"}]',
      viewport: '{"x":0}',
      createdAt: now,
      updatedAt: now,
    })

    const req = fakeReq('GET')
    const res = fakeRes()
    handleCanvasRoute('/api/canvas/sess-1', 'GET', req, res, storage)
    expect(res._status).toBe(200)
    const body = JSON.parse(res._body)
    expect(body.canvas).not.toBeNull()
    expect(body.canvas.sessionId).toBe('sess-1')
    expect(body.canvas.shapes).toBe('[{"type":"rect"}]')
  })

  it('GET rejects invalid sessionId (too long)', () => {
    const longId = 'a'.repeat(200)
    const req = fakeReq('GET')
    const res = fakeRes()
    handleCanvasRoute(`/api/canvas/${longId}`, 'GET', req, res, storage)
    expect(res._status).toBe(400)
    expect(JSON.parse(res._body).error).toContain('Invalid session id')
  })

  it('GET rejects sessionId with path traversal', () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    handleCanvasRoute('/api/canvas/..%2F..%2Fetc', 'GET', req, res, storage)
    expect(res._status).toBe(400)
  })

  // -- PUT /api/canvas/:sessionId -------------------------------------------

  it('PUT saves a new canvas state', async () => {
    const req = fakeReq('PUT', { shapes: '[{"type":"circle"}]', viewport: '{}' })
    const res = fakeRes()
    handleCanvasRoute('/api/canvas/sess-put', 'PUT', req, res, storage)

    await tick()

    expect(res._status).toBe(200)
    expect(JSON.parse(res._body).status).toBe('saved')

    const saved = storage.getBySession('sess-put')
    expect(saved).not.toBeNull()
    expect(saved!.shapes).toBe('[{"type":"circle"}]')
  })

  it('PUT upserts existing canvas state', async () => {
    const now = Date.now()
    storage.save({
      id: 'sess-up',
      sessionId: 'sess-up',
      shapes: '[]',
      createdAt: now,
      updatedAt: now,
    })

    const req = fakeReq('PUT', { id: 'sess-up', shapes: '[{"new":true}]' })
    const res = fakeRes()
    handleCanvasRoute('/api/canvas/sess-up', 'PUT', req, res, storage)

    await tick()

    expect(res._status).toBe(200)
    const saved = storage.getBySession('sess-up')
    expect(saved!.shapes).toBe('[{"new":true}]')
  })

  it('PUT rejects invalid sessionId', async () => {
    const req = fakeReq('PUT', { shapes: '[]' })
    const res = fakeRes()
    handleCanvasRoute('/api/canvas/' + 'x'.repeat(200), 'PUT', req, res, storage)
    expect(res._status).toBe(400)
  })

  // -- DELETE /api/canvas/:sessionId ----------------------------------------

  it('DELETE removes existing canvas', () => {
    const now = Date.now()
    storage.save({ id: 'del1', sessionId: 'del1', shapes: '[]', createdAt: now, updatedAt: now })

    const req = fakeReq('DELETE')
    const res = fakeRes()
    handleCanvasRoute('/api/canvas/del1', 'DELETE', req, res, storage)
    expect(res._status).toBe(200)
    expect(JSON.parse(res._body).status).toBe('deleted')
    expect(storage.getBySession('del1')).toBeNull()
  })

  it('DELETE returns not_found for missing canvas', () => {
    const req = fakeReq('DELETE')
    const res = fakeRes()
    handleCanvasRoute('/api/canvas/nope', 'DELETE', req, res, storage)
    expect(res._status).toBe(200)
    expect(JSON.parse(res._body).status).toBe('not_found')
  })

  // -- GET /api/canvas/project/:fingerprint ---------------------------------

  it('GET project listing returns empty array for unknown fingerprint', () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    handleCanvasRoute('/api/canvas/project/fp-unknown', 'GET', req, res, storage)
    expect(res._status).toBe(200)
    expect(JSON.parse(res._body).canvases).toEqual([])
  })

  it('GET project listing returns canvases for a fingerprint', () => {
    const now = Date.now()
    storage.save({ id: 'p1', sessionId: 's1', projectFingerprint: 'fp1', shapes: '[]', createdAt: now, updatedAt: now })
    storage.save({ id: 'p2', sessionId: 's2', projectFingerprint: 'fp1', shapes: '[]', createdAt: now, updatedAt: now + 1 })

    const req = fakeReq('GET')
    const res = fakeRes()
    handleCanvasRoute('/api/canvas/project/fp1', 'GET', req, res, storage)
    expect(res._status).toBe(200)
    const body = JSON.parse(res._body)
    expect(body.canvases).toHaveLength(2)
  })

  // -- POST /api/canvas/:sessionId/export -----------------------------------

  it('POST export returns 404 for missing canvas', async () => {
    const req = fakeReq('POST')
    const res = fakeRes()
    handleCanvasRoute('/api/canvas/no-sess/export', 'POST', req, res, storage)
    expect(res._status).toBe(404)
  })

  it('POST export returns parsed shapes for existing canvas', () => {
    const now = Date.now()
    storage.save({
      id: 'exp1',
      sessionId: 'exp1',
      shapes: '[{"type":"rect","id":"s1"}]',
      viewport: '{"x":10,"y":20,"zoom":1}',
      createdAt: now,
      updatedAt: now,
    })

    const req = fakeReq('POST')
    const res = fakeRes()
    handleCanvasRoute('/api/canvas/exp1/export', 'POST', req, res, storage)
    expect(res._status).toBe(200)
    const body = JSON.parse(res._body)
    expect(body.sessionId).toBe('exp1')
    expect(body.shapes).toEqual([{ type: 'rect', id: 's1' }])
    expect(body.viewport).toEqual({ x: 10, y: 20, zoom: 1 })
    expect(body.exportedAt).toBeTypeOf('number')
  })

  // -- 404 within namespace -------------------------------------------------

  it('returns 404 for unknown /api/canvas/* sub-path', () => {
    const req = fakeReq('PATCH')
    const res = fakeRes()
    const handled = handleCanvasRoute('/api/canvas/sess-1', 'PATCH', req, res, storage)
    expect(handled).toBe(true)
    expect(res._status).toBe(404)
  })
})
