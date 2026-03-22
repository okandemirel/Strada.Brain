import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { CanvasStorage, type CanvasState } from '../../dashboard/canvas-storage.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<CanvasState> = {}): CanvasState {
  const now = Date.now()
  return {
    id: overrides.id ?? 'canvas-1',
    sessionId: overrides.sessionId ?? 'sess-1',
    userId: overrides.userId,
    projectFingerprint: overrides.projectFingerprint,
    shapes: overrides.shapes ?? '[]',
    viewport: overrides.viewport,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CanvasStorage', () => {
  let db: Database.Database
  let storage: CanvasStorage

  beforeEach(() => {
    db = new Database(':memory:')
    storage = new CanvasStorage(db)
  })

  // -- getBySession ---------------------------------------------------------

  it('returns null for a non-existent session', () => {
    expect(storage.getBySession('no-such-session')).toBeNull()
  })

  it('retrieves a previously saved canvas state', () => {
    const state = makeState({ id: 'c1', sessionId: 's1', shapes: '[{"type":"rect"}]' })
    storage.save(state)
    const result = storage.getBySession('s1')
    expect(result).not.toBeNull()
    expect(result!.id).toBe('c1')
    expect(result!.sessionId).toBe('s1')
    expect(result!.shapes).toBe('[{"type":"rect"}]')
  })

  it('returns userId and projectFingerprint when set', () => {
    const state = makeState({ userId: 'u1', projectFingerprint: 'fp1' })
    storage.save(state)
    const result = storage.getBySession('sess-1')
    expect(result!.userId).toBe('u1')
    expect(result!.projectFingerprint).toBe('fp1')
  })

  it('returns undefined for optional fields when null in DB', () => {
    const state = makeState()
    storage.save(state)
    const result = storage.getBySession('sess-1')
    expect(result!.userId).toBeUndefined()
    expect(result!.projectFingerprint).toBeUndefined()
    expect(result!.viewport).toBeUndefined()
  })

  // -- save (upsert) --------------------------------------------------------

  it('inserts a new canvas state', () => {
    const state = makeState({ id: 'new-1', sessionId: 'new-sess' })
    storage.save(state)
    const result = storage.getBySession('new-sess')
    expect(result).not.toBeNull()
    expect(result!.id).toBe('new-1')
  })

  it('upserts: updates shapes and updatedAt on conflict', () => {
    const state = makeState({ id: 'c1', shapes: '[]', createdAt: 1000, updatedAt: 1000 })
    storage.save(state)

    const updated = makeState({ id: 'c1', shapes: '[{"type":"circle"}]', createdAt: 1000, updatedAt: 2000 })
    storage.save(updated)

    const result = storage.getBySession('sess-1')
    expect(result!.shapes).toBe('[{"type":"circle"}]')
    expect(result!.updatedAt).toBe(2000)
  })

  it('upserts: updates viewport on conflict', () => {
    const state = makeState({ id: 'c1', viewport: '{"x":0}' })
    storage.save(state)

    const updated = makeState({ id: 'c1', viewport: '{"x":100,"y":50,"zoom":2}' })
    storage.save(updated)

    const result = storage.getBySession('sess-1')
    expect(result!.viewport).toBe('{"x":100,"y":50,"zoom":2}')
  })

  it('stores and retrieves createdAt / updatedAt timestamps', () => {
    const state = makeState({ createdAt: 1111, updatedAt: 2222 })
    storage.save(state)
    const result = storage.getBySession('sess-1')
    expect(result!.createdAt).toBe(1111)
    expect(result!.updatedAt).toBe(2222)
  })

  // -- delete ---------------------------------------------------------------

  it('deletes an existing canvas and returns true', () => {
    storage.save(makeState())
    expect(storage.delete('sess-1')).toBe(true)
    expect(storage.getBySession('sess-1')).toBeNull()
  })

  it('returns false when deleting a non-existent session', () => {
    expect(storage.delete('no-such')).toBe(false)
  })

  // -- listByProject --------------------------------------------------------

  it('returns empty array when project has no canvases', () => {
    expect(storage.listByProject('fp-none')).toEqual([])
  })

  it('lists canvases for a project ordered by updatedAt desc', () => {
    storage.save(makeState({ id: 'c1', sessionId: 's1', projectFingerprint: 'fp1', updatedAt: 100 }))
    storage.save(makeState({ id: 'c2', sessionId: 's2', projectFingerprint: 'fp1', updatedAt: 300 }))
    storage.save(makeState({ id: 'c3', sessionId: 's3', projectFingerprint: 'fp1', updatedAt: 200 }))
    // Different project — should not appear
    storage.save(makeState({ id: 'c4', sessionId: 's4', projectFingerprint: 'fp2', updatedAt: 400 }))

    const results = storage.listByProject('fp1')
    expect(results).toHaveLength(3)
    expect(results[0].id).toBe('c2') // updatedAt 300
    expect(results[1].id).toBe('c3') // updatedAt 200
    expect(results[2].id).toBe('c1') // updatedAt 100
  })

  it('limits project listing to 100 entries', () => {
    for (let i = 0; i < 110; i++) {
      storage.save(makeState({ id: `c-${i}`, sessionId: `s-${i}`, projectFingerprint: 'fp-big', updatedAt: i }))
    }
    const results = storage.listByProject('fp-big')
    expect(results).toHaveLength(100)
  })

  // -- Table initialization --------------------------------------------------

  it('creates the table and indexes without errors on a fresh DB', () => {
    const freshDb = new Database(':memory:')
    const freshStorage = new CanvasStorage(freshDb)
    // Should not throw — table already created in constructor
    expect(freshStorage.getBySession('test')).toBeNull()
    freshDb.close()
  })

  it('is safe to construct twice on the same DB (IF NOT EXISTS)', () => {
    const secondStorage = new CanvasStorage(db)
    secondStorage.save(makeState({ id: 'dup-test', sessionId: 'dup-sess' }))
    expect(secondStorage.getBySession('dup-sess')).not.toBeNull()
  })
})
