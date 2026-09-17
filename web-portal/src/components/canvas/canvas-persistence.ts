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
 */
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
    this.gen += 1
    this.sessionId = sessionId
    this.version = undefined
    this.acked = false
    this.loading = sessionId !== null
    this.pendingEdit = false
    this.inFlight = null
    this.queued = false
    return this.gen
  }

  /**
   * This session's canvas has been read (or the read failed). Writing is
   * allowed from here on, and an edit made while it was loading goes out now.
   */
  finishLoad(generation: number): void {
    if (generation !== this.gen) return
    this.loading = false
    if (this.pendingEdit || this.queued) this.requestSave()
  }

  /**
   * May the CONTENT a GET returned still be applied to the canvas? No once the
   * session has moved on, no once we have saved (the read is then older than
   * what this window wrote), and no once the user has edited this session's
   * canvas — a slow first load must not undo their work (#20).
   */
  canApplyContent(generation: number): boolean {
    return generation === this.gen && !this.acked && !this.pendingEdit
  }

  /**
   * Adopt the version a load reported (`'absent'` for `canvas: null`). Local
   * edits do not make it wrong — it is still what the server holds — so this
   * is allowed where canApplyContent is not.
   */
  adoptVersion(version: CanvasSavePrecondition | undefined, generation: number): void {
    if (generation !== this.gen || this.acked) return
    this.version = version
  }

  /** An edit happened: save it once the canvas has been quiet for a moment. */
  requestSave(): void {
    if (!this.sessionId) return
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
    if (!this.sessionId) return
    // Writing before this session's canvas has been read would overwrite it
    // with whatever the previous session left in the store (#20).
    if (this.loading || this.inFlight) {
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

  /** Stop the debounce (unmount). An outstanding PUT is left to land. */
  dispose(): void {
    this.cancelTimer()
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private settle(generation: number, sent: CanvasSavePayload, result: CanvasSaveResult): void {
    // A response for a session the user has left, or for a canvas reloaded
    // since: it says nothing about what the server holds now (#20).
    if (generation !== this.gen) return
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
