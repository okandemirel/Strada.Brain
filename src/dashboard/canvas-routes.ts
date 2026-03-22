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
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { CanvasStorage, CanvasState } from "./canvas-storage.js";

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

/** Validate sessionId from URL: non-empty, max 128 chars, no path traversal. */
function isValidSessionId(id: string): boolean {
  return id.length > 0 && id.length <= 128 && !id.includes("..") && !id.includes("/");
}

// =============================================================================
// ROUTE HANDLER
// =============================================================================

/**
 * Handle /api/canvas/* requests.
 * Returns true if the request was handled, false if it should fall through.
 */
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
    try {
      const canvases = canvasStorage.listByProject(fingerprint);
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
      } catch {
        shapes = [];
      }
      jsonResponse(res, 200, {
        sessionId: state.sessionId,
        shapes,
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
    try {
      const state = canvasStorage.getBySession(sessionId);
      if (!state) {
        jsonResponse(res, 200, { canvas: null });
        return true;
      }
      jsonResponse(res, 200, { canvas: state });
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
    void readJsonBody<Partial<CanvasState>>(req, res).then((parsed) => {
      if (!parsed) return;

      const now = Date.now();
      const state: CanvasState = {
        id: parsed.id ?? sessionId,
        sessionId,
        userId: parsed.userId,
        projectFingerprint: parsed.projectFingerprint,
        shapes: typeof parsed.shapes === "string" ? parsed.shapes : JSON.stringify(parsed.shapes ?? []),
        viewport: typeof parsed.viewport === "string" ? parsed.viewport : (parsed.viewport ? JSON.stringify(parsed.viewport) : undefined),
        createdAt: parsed.createdAt ?? now,
        updatedAt: now,
      };

      try {
        canvasStorage.save(state);
        jsonResponse(res, 200, { status: "saved", sessionId });
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
