/**
 * Canvas REST Endpoints
 *
 * Provides REST API endpoints for the workspace canvas:
 *   GET    /api/canvas/:sessionId              -- return canvas state
 *   PUT    /api/canvas/:sessionId              -- save (upsert) canvas state
 *   DELETE /api/canvas/:sessionId              -- delete canvas
 *   GET    /api/canvas/project/:fingerprint    -- list project canvases
 *   POST   /api/canvas/:sessionId/export       -- export shapes as JSON
 *
 * Follows the inline route-matching pattern used by DashboardServer.
 *
 * WHOSE CANVAS IS IT (Codex round 14 #2). The portal keys every canvas by the
 * browser's own profile id (`useCanvasStore.setSessionId(profileId)`) and these
 * routes are the only writers there are, so a row IS one identity's work — the
 * notes and plans it typed. Nothing checked that: a guest's
 * `DELETE /api/canvas/<the owner's profile>` reached storage and answered 200, a
 * GET handed back the owner's shapes, and a PUT wrote whatever `userId` the body
 * claimed — an ownership field under the caller's control.
 *
 * Every route now asks the shared-instance model (surface `canvas:state`, scope
 * own-identity) through the one resolver every HTTP surface uses
 * (src/channels/web/instance-authorization.ts):
 *   - the OWNER of a row is its stored `user_id`, else the session it is keyed by;
 *   - the CALLER is the verified profile pair, never a claimed header or body field;
 *   - a project listing returns the caller's own canvases rather than refusing,
 *     because "list mine" is the question it is asked;
 *   - an instance that has issued no web identity keeps working untouched, and an
 *     identity store that cannot be read is a 503, not an implicit grant.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { CANVAS_VERSION_ABSENT } from "./canvas-storage.js";
import type { CanvasStorage, CanvasState } from "./canvas-storage.js";
import { getLogger, getLoggerSafe } from "../utils/logger.js";
import {
  authorizeInstanceRequest,
  verifiedRequestIdentity,
} from "../channels/web/instance-authorization.js";

// =============================================================================
// HELPERS
// =============================================================================

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJsonBody<T>(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes = 1_048_576, // 1 MB — canvas shapes can be large
): Promise<T | null> {
  return new Promise((resolve) => {
    let body = "";
    let bodyBytes = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      bodyBytes += chunk.length;
      if (bodyBytes > maxBytes) {
        aborted = true;
        req.on("error", () => {});
        req.destroy();
        jsonResponse(res, 413, { error: "Request body too large" });
        resolve(null);
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => {
      if (aborted) return;
      try {
        resolve(JSON.parse(body || "{}") as T);
      } catch {
        jsonResponse(res, 400, { error: "Invalid JSON body" });
        resolve(null);
      }
    });
  });
}

/**
 * Connections the canvas may store: an id and the two shape ids it joins.
 * They were drawn, held in the store and then dropped on save, so a reopened
 * session showed shapes with no arrows (plan 2.6 / audit 11.3 / D33).
 */
function validConnections(raw: unknown, sessionId: string): Array<Record<string, unknown>> {
  const list = typeof raw === "string"
    ? (() => { try { return JSON.parse(raw) as unknown; } catch { return []; } })()
    : (raw ?? []);
  if (!Array.isArray(list)) return [];
  return list.filter((c: unknown) => {
    if (!c || typeof c !== "object") return false;
    const conn = c as Record<string, unknown>;
    if (typeof conn.id !== "string" || typeof conn.from !== "string" || typeof conn.to !== "string") {
      getLogger().warn("Filtered invalid canvas connection", { sessionId, connection: conn });
      return false;
    }
    return true;
  }) as Array<Record<string, unknown>>;
}

/**
 * The precondition a save may carry: `undefined` (no precondition at all),
 * CANVAS_VERSION_ABSENT (0 — "there is no canvas yet, create it") or the
 * positive version this write replaces. Anything else is a malformed request:
 * coercing it would turn a client bug into an unconditional overwrite.
 */
function isValidSaveVersion(value: unknown): value is number | undefined {
  if (value === undefined) return true;
  return typeof value === "number" && Number.isInteger(value) && value >= CANVAS_VERSION_ABSENT;
}

/** Validate sessionId from URL: non-empty, max 128 chars, no path traversal, no null bytes or backslashes. */
function isValidSessionId(id: string): boolean {
  return id.length > 0 && id.length <= 128 && !/[/\\\x00]/.test(id) && !id.includes("..");
}

// =============================================================================
// WHO IS ASKING (round 14 #2)
// =============================================================================

/** The stored row for `sessionId`, or undefined — never throwing at the caller. */
function storedCanvas(canvasStorage: CanvasStorage, sessionId: string): CanvasState | undefined {
  try {
    return canvasStorage.getBySession(sessionId) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The identity a canvas belongs to: the owner recorded on the row, else the
 * session the canvas is keyed by — which IS the portal's profile id.
 *
 * A canvas that does not exist yet belongs to the session named in the URL, not
 * to nobody: that is what makes a first save work for the identity making it
 * (`/api/canvas/<my profile>`) while refusing a guest that reaches for a session
 * id it does not own — including one with no row behind it yet, which would
 * otherwise let a guest pre-empt another identity's canvas.
 */
function canvasOwner(canvasStorage: CanvasStorage, sessionId: string): string {
  let stored: CanvasState | null = null;
  try {
    stored = canvasStorage.getBySession(sessionId);
  } catch {
    // A storage failure is reported by the route that was going to use it; for
    // the purpose of ownership, fall back to the session the URL names.
    return sessionId;
  }
  return stored?.userId?.trim() || stored?.sessionId || sessionId;
}

/** Answer and return false when this caller may not touch `sessionId`'s canvas. */
function allowCanvas(
  req: IncomingMessage,
  res: ServerResponse,
  canvasStorage: CanvasStorage,
  sessionId: string,
  what: string,
): boolean {
  const owner = canvasOwner(canvasStorage, sessionId);
  const verdict = authorizeInstanceRequest(req.headers, "canvas:state", what, { profileId: owner });
  if (verdict.kind === "unavailable") {
    getLoggerSafe().error("Canvas request refused: the instance's identities cannot be read", {
      what,
      why: verdict.why,
    });
    jsonResponse(res, 503, {
      error: "Identity state unavailable",
      reason: `whose canvas this is cannot be established right now: ${verdict.why}. Refusing rather than guessing.`,
      code: "unavailable:identity-store",
    });
    return false;
  }
  if (verdict.decision.allowed) return true;
  getLoggerSafe().warn("Canvas request refused by the shared-instance model", {
    what,
    code: verdict.decision.code,
    reason: verdict.decision.reason,
  });
  jsonResponse(res, 403, {
    error: "Forbidden",
    reason: verdict.decision.reason,
    surface: verdict.decision.surface,
    code: verdict.decision.code,
  });
  return false;
}

// =============================================================================
// ROUTE HANDLER
// =============================================================================

/**
 * Handle /api/canvas/* requests.
 * Returns true if the request was handled, false if it should fall through.
 */
/** The listing route, named once for the refusal reasons. */
const PROJECT_LISTING = "/api/canvas/project";

export function handleCanvasRoute(
  url: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  canvasStorage: CanvasStorage | undefined,
): boolean {
  if (!url.startsWith("/api/canvas")) return false;

  if (!canvasStorage) {
    jsonResponse(res, 503, { error: "Canvas storage not available" });
    return true;
  }

  // -- GET /api/canvas/project/:fingerprint -- list canvases for a project ---
  const projectMatch = url.match(/^\/api\/canvas\/project\/([^/?]+)(?:\?.*)?$/);
  if (method === "GET" && projectMatch) {
    const fingerprint = decodeURIComponent(projectMatch[1]!);
    if (!isValidSessionId(fingerprint)) {
      jsonResponse(res, 400, { error: "Invalid project fingerprint" });
      return true;
    }
    // A listing is scoped, not refused: "which of MY canvases are in this
    // project" is the question, and answering it with somebody else's rows was
    // the leak. A caller that proves no identity gets nothing on an instance
    // that has identities — there is no row it can be shown to own.
    const reader = verifiedRequestIdentity(req.headers);
    if (reader.kind === "unavailable") {
      jsonResponse(res, 503, {
        error: "Identity state unavailable",
        reason: `whose canvases these are cannot be established right now: ${reader.why}. Refusing rather than guessing.`,
        code: "unavailable:identity-store",
      });
      return true;
    }
    try {
      const canvases = canvasStorage.listByProject(fingerprint).filter((canvas) => {
        const owner = canvas.userId?.trim() || canvas.sessionId;
        const verdict = authorizeInstanceRequest(
          req.headers,
          "canvas:state",
          `GET ${PROJECT_LISTING} ${canvas.sessionId}`,
          { profileId: owner },
        );
        return verdict.kind === "decision" && verdict.decision.allowed;
      });
      jsonResponse(res, 200, { canvases });
    } catch {
      jsonResponse(res, 500, { error: "Failed to list canvases" });
    }
    return true;
  }

  // -- POST /api/canvas/:sessionId/export -- export canvas shapes as JSON ----
  const exportMatch = url.match(/^\/api\/canvas\/([^/?]+)\/export$/);
  if (method === "POST" && exportMatch) {
    const sessionId = decodeURIComponent(exportMatch[1]!);
    if (!isValidSessionId(sessionId)) {
      jsonResponse(res, 400, { error: "Invalid session id" });
      return true;
    }
    if (!allowCanvas(req, res, canvasStorage, sessionId, `POST /api/canvas/${sessionId}/export`)) return true;
    try {
      const state = canvasStorage.getBySession(sessionId);
      if (!state) {
        jsonResponse(res, 404, { error: "Canvas not found" });
        return true;
      }
      // Parse and re-serialize shapes to guarantee clean JSON output
      let shapes: unknown;
      try {
        shapes = JSON.parse(state.shapes);
      } catch (parseError) {
        getLogger().error("Corrupted canvas state", { sessionId, error: String(parseError) });
        jsonResponse(res, 500, { error: "Corrupted canvas state", sessionId });
        return true;
      }
      let connections: unknown = [];
      try {
        connections = state.connections ? JSON.parse(state.connections) : [];
      } catch {
        connections = [];
      }
      jsonResponse(res, 200, {
        sessionId: state.sessionId,
        shapes,
        connections,
        viewport: state.viewport ? JSON.parse(state.viewport) : null,
        exportedAt: Date.now(),
      });
    } catch {
      jsonResponse(res, 500, { error: "Failed to export canvas" });
    }
    return true;
  }

  // -- GET /api/canvas/:sessionId -- return canvas state ---------------------
  const sessionMatch = url.match(/^\/api\/canvas\/([^/?]+)(?:\?.*)?$/);
  if (method === "GET" && sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]!);
    if (!isValidSessionId(sessionId)) {
      jsonResponse(res, 400, { error: "Invalid session id" });
      return true;
    }
    if (!allowCanvas(req, res, canvasStorage, sessionId, `GET /api/canvas/${sessionId}`)) return true;
    try {
      const state = canvasStorage.getBySession(sessionId);
      if (!state) {
        jsonResponse(res, 200, { canvas: null });
        return true;
      }
      jsonResponse(res, 200, { canvas: { ...state, version: state.version ?? 1 } });
    } catch {
      jsonResponse(res, 500, { error: "Failed to retrieve canvas" });
    }
    return true;
  }

  // -- PUT /api/canvas/:sessionId -- save (upsert) canvas state -------------
  if (method === "PUT" && sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]!);
    if (!isValidSessionId(sessionId)) {
      jsonResponse(res, 400, { error: "Invalid session id" });
      return true;
    }
    if (!allowCanvas(req, res, canvasStorage, sessionId, `PUT /api/canvas/${sessionId}`)) return true;
    // WHO OWNS WHAT THIS WRITES. `parsed.userId` came from the body, so the row's
    // ownership column was set by the caller — including to somebody else. The
    // owner of a row is the identity the request PROVES; when it proves none the
    // column is left as it was (an instance with no identities records nobody).
    const writerIdentity = verifiedRequestIdentity(req.headers);
    if (writerIdentity.kind === "unavailable") {
      jsonResponse(res, 503, {
        error: "Identity state unavailable",
        reason: `whose canvas this would be cannot be established right now: ${writerIdentity.why}. Refusing rather than guessing.`,
        code: "unavailable:identity-store",
      });
      return true;
    }
    void readJsonBody<Partial<CanvasState>>(req, res).then((parsed) => {
      if (!parsed) return;

      if (!isValidSaveVersion(parsed.version)) {
        jsonResponse(res, 400, { error: "Invalid version", sessionId });
        return;
      }

      const now = Date.now();

      // Validate shapes: each must have at minimum id (string) and type (string)
      const rawShapes = typeof parsed.shapes === "string"
        ? (() => { try { return JSON.parse(parsed.shapes) as unknown; } catch { return []; } })()
        : (parsed.shapes ?? []);
      const validShapes = Array.isArray(rawShapes)
        ? rawShapes.filter((s: unknown) => {
            if (!s || typeof s !== "object") return false;
            const shape = s as Record<string, unknown>;
            if (typeof shape.id !== "string" || typeof shape.type !== "string") {
              getLogger().warn("Filtered invalid canvas shape", { sessionId, shape });
              return false;
            }
            return true;
          })
        : [];

      const state: CanvasState = {
        // ROUND 15 #1 — THE ROW THAT IS AUTHORIZED IS THE ROW THAT IS WRITTEN.
        //
        // `id` is the storage PRIMARY KEY (canvas_states.id, the target of every
        // upsert) and it came from the BODY, while authorization checked the
        // SESSION in the URL. A guest PUT to its own /api/canvas/<guest> carrying
        // {id:"<owner>", version:1} therefore updated the OWNER's row — its
        // shapes and its user_id, i.e. the ownership column itself. Two
        // identifiers, one checked and the other acted on.
        //
        // The id now comes from the row this session already has, or from the
        // session itself for a first save. A body id is ignored outright rather
        // than validated: there is no request in which a client needs to name the
        // primary key of a row it is not addressing.
        id: storedCanvas(canvasStorage, sessionId)?.id ?? sessionId,
        sessionId,
        userId: writerIdentity.viewer,
        projectFingerprint: parsed.projectFingerprint,
        shapes: JSON.stringify(validShapes),
        connections: JSON.stringify(validConnections(parsed.connections, sessionId)),
        viewport: typeof parsed.viewport === "string" ? parsed.viewport : (parsed.viewport ? JSON.stringify(parsed.viewport) : undefined),
        version: parsed.version,
        createdAt: parsed.createdAt ?? now,
        updatedAt: now,
      };

      try {
        const outcome = canvasStorage.save(state);
        if (!outcome.ok) {
          // Either another writer moved the version on, or this client believed
          // the canvas did not exist yet and it does (r9 #17). Both leave the
          // client's work unsaved and dirty rather than overwriting.
          jsonResponse(res, 409, {
            error: outcome.reason === "already_exists" ? "Canvas already exists" : "Version conflict",
            sessionId,
          });
          return;
        }
        // The ack carries the version OF THIS WRITE — read back inside the
        // write's own transaction. A separate getBySession() could have
        // reported a concurrent writer's version, which the client would then
        // have used to overwrite content it never saw (r9 #21).
        jsonResponse(res, 200, { status: "saved", sessionId, version: outcome.version });
      } catch {
        jsonResponse(res, 500, { error: "Failed to save canvas" });
      }
    });
    return true;
  }

  // -- DELETE /api/canvas/:sessionId -- delete canvas state ------------------
  const deleteMatch = url.match(/^\/api\/canvas\/([^/?]+)$/);
  if (method === "DELETE" && deleteMatch) {
    const sessionId = decodeURIComponent(deleteMatch[1]!);
    if (!isValidSessionId(sessionId)) {
      jsonResponse(res, 400, { error: "Invalid session id" });
      return true;
    }
    if (!allowCanvas(req, res, canvasStorage, sessionId, `DELETE /api/canvas/${sessionId}`)) return true;
    try {
      const deleted = canvasStorage.delete(sessionId);
      jsonResponse(res, 200, { status: deleted ? "deleted" : "not_found", sessionId });
    } catch {
      jsonResponse(res, 500, { error: "Failed to delete canvas" });
    }
    return true;
  }

  // No match within /api/canvas namespace
  jsonResponse(res, 404, { error: "Canvas endpoint not found" });
  return true;
}
