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
 */
import type { CanvasConnection, ResolvedShape } from './canvas-types'

/** Exactly what a save sends: the serialized revision of the canvas. */
export interface CanvasSavePayload {
  shapes: string
  connections: string
  viewport: string
}

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
  version?: number
  fetchImpl?: typeof fetch
}): Promise<CanvasSaveResult> {
  const doFetch = args.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(`/api/canvas/${encodeURIComponent(args.sessionId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shapes: args.payload.shapes,
        connections: args.payload.connections,
        viewport: args.payload.viewport,
        ...(args.version === undefined ? {} : { version: args.version }),
      }),
    })
  } catch {
    // Offline or refused: the edits are still only in this browser.
    return { kind: 'failed', status: null }
  }
  if (res.status === 409) return { kind: 'conflict' }
  if (!res.ok) return { kind: 'failed', status: res.status }
  const body = await res.json().catch(() => null)
  return { kind: 'saved', version: readCanvasVersion(body) ?? (args.version ?? 0) + 1 }
}
