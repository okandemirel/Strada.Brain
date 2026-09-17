/**
 * CANVAS PERSISTENCE — what a save means (plan 2.6, audit 11.3 / D33,
 * Codex #25).
 *
 * The auto-save used to `fetch(...).then(() => setDirty(false))`: a 500, a
 * 409 and a success all cleared the dirty flag, so a failed save looked
 * identical to a stored one and the edits were never retried. Connections
 * were not sent at all, and no version went with the write, so two windows
 * silently overwrote each other.
 *
 * The rules live here, out of the React effect, so they can be tested:
 *   - only a 2xx counts as saved, and it carries the version to send next;
 *   - 409 is a conflict the caller must surface, not a success;
 *   - any other status or a network error leaves the work dirty;
 *   - the dirty flag is cleared only for the revision that was acked —
 *     an edit made while the request was in flight stays dirty.
 *
 * Round 9 added the scheduler at the bottom of this file, because the rules
 * above are not enough on their own:
 *   - #17 an absent canvas is a precondition of its own (CANVAS_VERSION_ABSENT
 *     on the wire), not "no version": two windows that both read
 *     `canvas: null` used to overwrite each other;
 *   - #18 saves serialize. A second debounce fired while a PUT was in flight
 *     used to reuse the same version, so a window conflicted with itself;
 *   - #19 the queued revision is drained after every acknowledgement, whatever
 *     changed — a connection drawn during a save used to stay dirty forever;
 *   - #20 every request belongs to a session generation. A previous session's
 *     acknowledgement, or a slow first GET, used to overwrite the current
 *     session's version and shapes.
 *
 * Round 10 closed the three ways a write could still be authorized by something
 * that is not the server's answer for THIS canvas:
 *   - #8 dispose() cancelled the debounce and left the outstanding PUT's
 *     continuation live. It read the store — by then another session's canvas —
 *     and scheduled a second write addressed to the session the user had left;
 *   - #9 a FAILED read used to authorize writing. With no version the PUT
 *     carries no precondition, which the server applies as an unconditional
 *     upsert: the other window's version 7 is destroyed with no 409. Nothing is
 *     written until a version, or an explicit absence, is established;
 *   - #10 a slow read's VERSION was adopted while its CONTENT was dropped
 *     (because a local edit had arrived first), so the next save wrote the local
 *     shapes alone against that version and deleted the server's. The work done
 *     while the read was open is now REPLAYED onto what the read returned.
 *
 * Round 11 narrowed that replay from the object to the PROPERTY:
 *   - #9 taking the whole LOCAL object for a shape both sides hold erased every
 *     remote edit to a DIFFERENT field of it — the user drags the shape, the
 *     server's copy gets a new label, and the label is gone; the versioned PUT
 *     then destroys it on the server too. Only the properties that changed here
 *     are replayed, and a property BOTH sides changed is reported as a conflict
 *     instead of being decided silently. Connections are replayed the same way;
 *   - #10 an EMPTY saved canvas could not be told from an unreadable one —
 *     parsing answered `null` for both — so the shapes a PREVIOUS session had
 *     left in the store were installed as this canvas's content and then written
 *     into it. parseStoredShapes lives here now (it is what a save has to read
 *     back) and answers `[]` for an empty canvas, `null` only for one that
 *     cannot be read at all.
 */
import { isValidResolvedShape } from '../../stores/canvas-store'
import { getDefaultDimensions } from './canvas-types'
import type { CanvasConnection, ResolvedShape } from './canvas-types'

/** Exactly what a save sends: the serialized revision of the canvas. */
export interface CanvasSavePayload {
  shapes: string
  connections: string
  viewport: string
}

/**
 * "There is no canvas yet." Distinct from sending no version at all, which is
 * an unconditional overwrite (r9 #17). Mirrors CANVAS_VERSION_ABSENT server
 * side.
 */
export const CANVAS_VERSION_ABSENT = 0

/**
 * What the client believes the server holds: a positive version, `'absent'`
 * (the GET said `canvas: null`), or `undefined` — not known, so the write
 * carries no precondition at all.
 */
export type CanvasSavePrecondition = number | 'absent'

export type CanvasSaveResult =
  | { kind: 'saved'; version: number }
  | { kind: 'conflict' }
  | { kind: 'failed'; status: number | null }

export function canvasSavePayload(
  shapes: readonly ResolvedShape[],
  connections: readonly CanvasConnection[],
  viewport: unknown,
): CanvasSavePayload {
  return {
    shapes: JSON.stringify(shapes),
    connections: JSON.stringify(connections),
    viewport: JSON.stringify(viewport),
  }
}

/** Two payloads describe the same canvas revision. */
export function samePayload(a: CanvasSavePayload, b: CanvasSavePayload): boolean {
  return a.shapes === b.shapes && a.connections === b.connections && a.viewport === b.viewport
}

/**
 * The version the server holds, from a GET or a PUT ack. `undefined` when the
 * response does not say — the next save then goes without a version rather
 * than inventing one.
 */
export function readCanvasVersion(data: unknown): number | undefined {
  if (!data || typeof data !== 'object') return undefined
  const value = (data as { version?: unknown }).version
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Connections as stored: a JSON string (or an array) of {id, from, to}. */
export function parseCanvasConnections(raw: unknown): CanvasConnection[] {
  const list = typeof raw === 'string'
    ? (() => { try { return JSON.parse(raw) as unknown } catch { return [] } })()
    : raw
  if (!Array.isArray(list)) return []
  const out: CanvasConnection[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const c = entry as Record<string, unknown>
    if (typeof c.id !== 'string' || typeof c.from !== 'string' || typeof c.to !== 'string') continue
    out.push({
      id: c.id,
      from: c.from,
      to: c.to,
      ...(typeof c.label === 'string' ? { label: c.label } : {}),
    })
  }
  return out
}

/* ── Reading what the server stored ──────────────────────────────────────── */

/**
 * The shapes a stored canvas holds: a list — `[]` included, because a canvas
 * stored EMPTY is a canvas, not a missing one — or `null` when the payload
 * cannot be READ at all.
 *
 * The two used to be the same answer, and that is r11 #10: an empty canvas came
 * back as `null`, so the shapes the PREVIOUS session had left in the store were
 * kept as this canvas's content — installed by the apply path, taken as the
 * loaded baseline by the replay, and then written into the new canvas by the
 * next save. `null` still means "leave the local canvas alone": clearing a
 * canvas because its row could not be parsed is the one thing worse.
 */
export function parseStoredShapes(raw: unknown): ResolvedShape[] | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  // The tldraw-era format: a keyed store of records, one per shape.
  if (parsed && typeof parsed === 'object' && 'store' in parsed) {
    const store = (parsed as { store: unknown }).store
    if (!store || typeof store !== 'object') return null
    const migrated: ResolvedShape[] = []
    let idx = 0
    for (const entry of Object.values(store as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      if (e.typeName !== 'shape') continue
      const dims = getDefaultDimensions(String(e.type ?? 'note-block'))
      const props = (e.props as Record<string, unknown>) ?? {}
      migrated.push({
        id: String(e.id ?? `migrated-${idx++}`),
        type: String(e.type ?? 'note-block'),
        x: typeof e.x === 'number' ? e.x : idx * 260,
        y: typeof e.y === 'number' ? e.y : 100,
        w: typeof props.w === 'number' ? props.w : dims.w,
        h: typeof props.h === 'number' ? props.h : dims.h,
        props,
        source: props.source as 'agent' | 'user' | undefined,
      })
    }
    // A readable store with no shape records in it is an EMPTY canvas (#10).
    return migrated
  }
  if (!Array.isArray(parsed)) return null
  const validated = parsed.filter(isValidResolvedShape)
  // Entries that are all unreadable are not an empty canvas: nothing usable came
  // back, so the canvas here is left alone instead of being cleared.
  if (parsed.length > 0 && validated.length === 0) return null
  return validated
}

export async function saveCanvasState(args: {
  sessionId: string
  payload: CanvasSavePayload
  version?: CanvasSavePrecondition
  fetchImpl?: typeof fetch
}): Promise<CanvasSaveResult> {
  const doFetch = args.fetchImpl ?? fetch
  const precondition = args.version === 'absent' ? CANVAS_VERSION_ABSENT : args.version
  let res: Response
  try {
    res = await doFetch(`/api/canvas/${encodeURIComponent(args.sessionId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shapes: args.payload.shapes,
        connections: args.payload.connections,
        viewport: args.payload.viewport,
        ...(precondition === undefined ? {} : { version: precondition }),
      }),
    })
  } catch {
    // Offline or refused: the edits are still only in this browser.
    return { kind: 'failed', status: null }
  }
  if (res.status === 409) return { kind: 'conflict' }
  if (!res.ok) return { kind: 'failed', status: res.status }
  const body = await res.json().catch(() => null)
  return {
    kind: 'saved',
    version: readCanvasVersion(body) ?? (typeof precondition === 'number' ? precondition : 0) + 1,
  }
}

/* ── Replaying the work done while a load was open (r10 #10, r11 #9) ─────── */

/** The two lists a canvas is made of, as the store and the server both hold them. */
export interface CanvasContent {
  shapes: readonly ResolvedShape[]
  connections: readonly CanvasConnection[]
}

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of items) map.set(item.id, item)
  return map
}

/**
 * JSON with object keys in a fixed order. `loaded` has been through the server
 * and a JSON round trip while `base`/`local` come straight from the store, so
 * key order is NOT something to compare values by (r11 #9).
 */
function stableJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v
    const record = v as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = record[key]
    return sorted
  })
}

/** The same value, whatever route it took to get here. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  const left = stableJson(a)
  // `undefined` is not JSON: an absent key must not compare equal to `null`
  // or to a key holding the string "undefined".
  if (left === undefined || stableJson(b) === undefined) return false
  return left === stableJson(b)
}

/** Same entity, unchanged. */
function unchanged<T>(a: T, b: T): boolean {
  return sameValue(a, b)
}

/** A property both sides changed while the read was open (r11 #9). */
export interface CanvasReplayConflict {
  kind: 'shape' | 'connection'
  /** The shape or connection id. */
  id: string
  /** Dotted path inside the entity: `x`, `props.label`, … */
  property: string
  /** What this window holds, and what the read returned. */
  local: unknown
  loaded: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Take the local value for one key — including "the local edit removed it". */
function takeLocal(out: Record<string, unknown>, key: string, local: Record<string, unknown>): void {
  if (key in local) out[key] = local[key]
  else delete out[key]
}

/**
 * Replay ONE entity property by property: the loaded copy, with every property
 * that changed HERE since the read began written over it.
 *
 *   - untouched here                → the server's value governs;
 *   - changed here only             → the local value is replayed;
 *   - changed on both sides, same   → nothing to decide;
 *   - changed on both sides, differ → a CONFLICT is reported. The local value
 *     stays (it is what the person is looking at; taking the server's would
 *     delete a keystroke under their cursor) and the caller surfaces it, so the
 *     choice is theirs rather than silent.
 *
 * Nested plain objects — `props` above all — are recursed into, so a local edit
 * to `props.content` and a remote edit to `props.label` are not a conflict.
 */
function replayProperties<T extends object>(
  base: T,
  local: T,
  loaded: T,
  report: (property: string, local: unknown, loaded: unknown) => void,
  path = '',
): T {
  const baseRecord = base as Record<string, unknown>
  const localRecord = local as Record<string, unknown>
  const loadedRecord = loaded as Record<string, unknown>
  const out: Record<string, unknown> = { ...loadedRecord }
  const keys = new Set([
    ...Object.keys(baseRecord),
    ...Object.keys(localRecord),
    ...Object.keys(loadedRecord),
  ])
  for (const key of keys) {
    const wasBase = baseRecord[key]
    const isLocal = localRecord[key]
    const isLoaded = loadedRecord[key]
    // Nothing was done to this property here, so the server's copy governs —
    // that is what keeps a remote edit to another field alive (#9).
    if (sameValue(wasBase, isLocal)) continue
    if (sameValue(wasBase, isLoaded)) {
      takeLocal(out, key, localRecord)
      continue
    }
    if (sameValue(isLocal, isLoaded)) continue // both sides did the same thing
    if (isPlainObject(wasBase) && isPlainObject(isLocal) && isPlainObject(isLoaded)) {
      out[key] = replayProperties(wasBase, isLocal, isLoaded, report, `${path}${key}.`)
      continue
    }
    report(`${path}${key}`, isLocal, isLoaded)
    takeLocal(out, key, localRecord)
  }
  return out as T
}

/**
 * Three-way replay for ONE list (shapes or connections).
 *
 * `base` is the canvas as it was when the read started, `local` is the canvas
 * now — so `local` minus `base` is exactly the work done while the read was
 * open — and `loaded` is what the server returned. The result is `loaded` with
 * that work replayed onto it:
 *   - added while loading            → kept (appended);
 *   - edited while loading           → the properties edited here are replayed
 *     onto the loaded copy, so the server's other fields survive (r11 #9);
 *   - deleted while loading          → removed from the loaded content too;
 *   - untouched since the read began → the server's copy governs, which is how a
 *     canvas left in the store by a PREVIOUS session stops leaking into this one.
 *
 * A delete cannot be told from "the shape was never here" without an operation
 * log, so a shape deleted while the read was open is honoured by id. Resurrect-
 * ing one is recoverable; silently deleting the server's canvas is not.
 */
function replayList<T extends { id: string }>(
  kind: CanvasReplayConflict['kind'],
  base: readonly T[],
  local: readonly T[],
  loaded: readonly T[],
  conflicts: CanvasReplayConflict[],
): T[] {
  const baseById = byId(base)
  const localById = byId(local)
  const out: T[] = []
  const placed = new Set<string>()

  for (const item of loaded) {
    const localItem = localById.get(item.id)
    const baseItem = baseById.get(item.id)
    if (!localItem && baseItem) continue // deleted while the read was open
    if (localItem && baseItem && !unchanged(baseItem, localItem)) {
      // Edited on this side. Both sides may have changed DIFFERENT properties of
      // the same entity, and taking the whole local object erased the remote
      // ones (#9).
      out.push(replayProperties(baseItem, localItem, item, (property, localValue, loadedValue) => {
        conflicts.push({ kind, id: item.id, property, local: localValue, loaded: loadedValue })
      }))
    } else if (localItem && !baseItem) {
      // Added here while the read was open, and the server has it under the same
      // id: there is no base to diff against, so this side's copy is taken whole.
      out.push(localItem)
    } else {
      out.push(item) // untouched here: the server's copy is the truth
    }
    placed.add(item.id)
  }

  for (const item of local) {
    if (placed.has(item.id)) continue
    const baseItem = baseById.get(item.id)
    // Untouched since the read began and absent from the server's canvas: it is
    // not this session's content (a previous session left it in the store).
    if (baseItem && unchanged(baseItem, item)) continue
    out.push(item)
  }

  return out
}

/**
 * The canvas a slow read must produce: everything the server holds, plus the
 * work done while it was in flight (#10), property by property (r11 #9). The
 * viewport is deliberately NOT part of this — the view the person is looking at
 * now wins.
 *
 * `conflicts` lists the properties both sides changed differently. The local
 * value is in the result; the conflict is what the caller shows the person, so
 * nothing is decided for them in silence.
 */
export function replayCanvasEdits(args: {
  base: CanvasContent
  local: CanvasContent
  loaded: CanvasContent
}): {
  shapes: ResolvedShape[]
  connections: CanvasConnection[]
  conflicts: CanvasReplayConflict[]
} {
  const conflicts: CanvasReplayConflict[] = []
  return {
    shapes: replayList('shape', args.base.shapes, args.local.shapes, args.loaded.shapes, conflicts),
    connections: replayList(
      'connection',
      args.base.connections,
      args.local.connections,
      args.loaded.connections,
      conflicts,
    ),
    conflicts,
  }
}

/* ── The save scheduler ───────────────────────────────────────────────────── */

export interface CanvasSaveSchedulerOptions {
  /** The canvas as it is right now — read at the moment a PUT goes out. */
  readRevision: () => CanvasSavePayload
  /** How a revision reaches the server (saveCanvasState in the app). */
  save: (args: {
    sessionId: string
    payload: CanvasSavePayload
    version?: CanvasSavePrecondition
  }) => Promise<CanvasSaveResult>
  /** `upToDate`: the acked revision is still the current one, so it is clean. */
  onSaved?: (info: { version: number; upToDate: boolean }) => void
  onConflict?: () => void
  onFailed?: (status: number | null) => void
  debounceMs?: number
}

/**
 * One writer for one canvas: a debounce, a single outstanding PUT, and the
 * server's acknowledged version as the only thing the next write may claim.
 *
 * Everything is tied to a session GENERATION. `startSession` bumps it, so a
 * response that belongs to a session the user has left changes nothing — no
 * version, no dirty flag, no conflict banner (#20).
 */
export class CanvasSaveScheduler {
  private sessionId: string | null = null
  private gen = 0
  private version: CanvasSavePrecondition | undefined
  /** A save has been acked in this generation: a load is now older than us. */
  private acked = false
  /** This session's canvas has not been read yet: nothing may be written. */
  private loading = false
  /** The read was attempted and did not happen: the canvas is still unknown (#9). */
  private loadFailed = false
  /** The workspace is gone: nothing may be scheduled, nothing may settle (#8). */
  private disposed = false
  /** The user has edited THIS session's canvas since it started loading. */
  private pendingEdit = false
  private inFlight: CanvasSavePayload | null = null
  private queued = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly debounceMs: number

  private readonly options: CanvasSaveSchedulerOptions

  constructor(options: CanvasSaveSchedulerOptions) {
    this.options = options
    this.debounceMs = options.debounceMs ?? 5_000
  }

  /** The generation to quote when handing back an async result. */
  get generation(): number {
    return this.gen
  }

  /** The precondition the next write will carry (for tests and diagnostics). */
  get precondition(): CanvasSavePrecondition | undefined {
    return this.version
  }

  /**
   * Point the scheduler at a session. Everything from the previous one — the
   * version, the queue, the pending acknowledgement — is dropped.
   */
  startSession(sessionId: string | null): number {
    this.cancelTimer()
    // Pointing the scheduler at a session again is an explicit re-adoption:
    // React (StrictMode) unmounts and remounts with the SAME instance, and a
    // disposal that bricked it would stop the canvas from ever saving in dev.
    // Nothing from before is revived — the generation has already moved on.
    this.disposed = false
    this.gen += 1
    this.sessionId = sessionId
    this.version = undefined
    this.acked = false
    this.loading = sessionId !== null
    this.loadFailed = false
    this.pendingEdit = false
    this.inFlight = null
    this.queued = false
    return this.gen
  }

  /**
   * This session's canvas HAS been read — the version it reported (or its
   * explicit absence) is adopted. Writing is allowed from here on, and an edit
   * made while it was loading goes out now.
   *
   * A read that did NOT happen must call failLoad instead: calling this for a
   * failed GET is what authorized an unconditional overwrite (#9).
   */
  finishLoad(generation: number): void {
    if (this.disposed || generation !== this.gen) return
    this.loading = false
    this.loadFailed = false
    if (this.pendingEdit || this.queued) this.requestSave()
  }

  /**
   * The read did not happen: a 500, a network error, or a canvas row whose
   * version cannot be read. The canvas stays UNREAD, so nothing may be written —
   * a PUT with no precondition is an unconditional upsert over a version this
   * window has never seen (#9). Edits made meanwhile are kept: the next
   * successful read replays them (#10) and flushes them.
   */
  failLoad(generation: number): void {
    if (this.disposed || generation !== this.gen) return
    this.loading = true
    this.loadFailed = true
  }

  /** The read failed and has not succeeded since (for the UI and diagnostics). */
  get loadDidFail(): boolean {
    return this.loadFailed
  }

  /**
   * May anything go out at all? Not without a session, not after disposal, not
   * before this canvas has been read, and never without a precondition.
   */
  get writable(): boolean {
    return !this.disposed && this.sessionId !== null && !this.loading && this.version !== undefined
  }

  /**
   * May the CONTENT a GET returned still be applied to the canvas? No once the
   * session has moved on, no once we have saved (the read is then older than
   * what this window wrote), and no once the user has edited this session's
   * canvas — a slow first load must not undo their work (#20).
   */
  canApplyContent(generation: number): boolean {
    return !this.disposed && generation === this.gen && !this.acked && !this.pendingEdit
  }

  /**
   * The read lost the race against a local edit. Its content may not REPLACE the
   * canvas — that would undo the edit — but it must still be merged into it:
   * dropping it while adopting its version is what deleted the server's shapes
   * (#10). Use replayCanvasEdits for the merge itself.
   */
  canMergeContent(generation: number): boolean {
    return !this.disposed && generation === this.gen && !this.acked && this.pendingEdit
  }

  /**
   * Adopt the version a load reported (`'absent'` for `canvas: null`). Local
   * edits do not make it wrong — it is still what the server holds — so this
   * is allowed where canApplyContent is not.
   */
  adoptVersion(version: CanvasSavePrecondition | undefined, generation: number): void {
    if (this.disposed || generation !== this.gen || this.acked) return
    this.version = version
  }

  /** An edit happened: save it once the canvas has been quiet for a moment. */
  requestSave(): void {
    if (this.disposed || !this.sessionId) return
    this.pendingEdit = true
    this.cancelTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.debounceMs)
  }

  /**
   * Send the current revision now, or queue it behind the outstanding one.
   * Saves never overlap, so the version a write claims is always one the
   * server has acknowledged (#18).
   */
  flush(): void {
    if (this.disposed || !this.sessionId) return
    // Writing before this session's canvas has been read would overwrite it
    // with whatever the previous session left in the store (#20) — and writing
    // with no precondition at all is an unconditional upsert over a version
    // this window has never seen, which is what a failed read used to
    // authorize (#9). The revision stays queued either way.
    if (this.loading || this.version === undefined || this.inFlight) {
      this.queued = true
      return
    }
    const generation = this.gen
    const sessionId = this.sessionId
    const payload = this.options.readRevision()
    this.inFlight = payload
    this.queued = false
    void this.options
      .save({ sessionId, payload, version: this.version })
      .then(
        (result) => this.settle(generation, payload, result),
        () => this.settle(generation, payload, { kind: 'failed', status: null }),
      )
  }

  /**
   * The workspace is gone. The debounce stops AND every outstanding callback is
   * invalidated: an ack that arrived after the unmount used to read the store —
   * by then another session's canvas — and schedule a second PUT addressed to
   * the session the user had left (#8). The request itself is left to land on
   * the server; its ANSWER no longer changes anything here.
   */
  dispose(): void {
    this.cancelTimer()
    this.disposed = true
    // The generation moves on, so a continuation still holding the old one is
    // answering for a session this scheduler no longer has.
    this.gen += 1
    this.sessionId = null
    this.inFlight = null
    this.queued = false
    this.pendingEdit = false
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private settle(generation: number, sent: CanvasSavePayload, result: CanvasSaveResult): void {
    // A response for a session the user has left, for a canvas reloaded since,
    // or for a workspace that has been unmounted: it says nothing about what
    // the server holds now, and there is nobody to tell (#20, #8).
    if (this.disposed || generation !== this.gen) return
    this.inFlight = null

    if (result.kind === 'conflict') {
      this.queued = false
      this.options.onConflict?.()
      return
    }
    if (result.kind === 'failed') {
      // Never stored: the work stays dirty and the next edit reschedules it.
      this.options.onFailed?.(result.status)
      return
    }

    this.version = result.version
    this.acked = true
    const upToDate = samePayload(sent, this.options.readRevision())
    const queued = this.queued
    this.queued = false
    this.options.onSaved?.({ version: result.version, upToDate })
    // Anything that changed while the PUT was open — a shape, a connection, the
    // viewport — is saved next, against the version just acknowledged (#18/#19).
    if (!upToDate || queued) this.requestSave()
  }
}
