import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleCanvasRoute } from "./canvas-routes.js";
import type { CanvasStorage, CanvasState } from "./canvas-storage.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// =============================================================================
// HELPERS — lightweight mocks for IncomingMessage / ServerResponse
// =============================================================================

/** Capture writeHead + end calls on a mock ServerResponse */
interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function createMockRes(): MockRes & ServerResponse {
  const mock: MockRes = {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead: vi.fn((status: number, headers?: Record<string, string>) => {
      mock.statusCode = status;
      if (headers) Object.assign(mock.headers, headers);
    }),
    end: vi.fn((data?: string) => {
      if (data) mock.body = data;
    }),
  };
  return mock as unknown as MockRes & ServerResponse;
}

/**
 * Create a mock IncomingMessage that emits data/end events.
 * Pass `body` to simulate a request body (for PUT/POST).
 */
function createMockReq(body?: string): IncomingMessage {
  const emitter = new EventEmitter();
  const req = emitter as unknown as IncomingMessage;

  // Schedule body emission on next tick so event listeners can attach
  if (body !== undefined) {
    process.nextTick(() => {
      emitter.emit("data", Buffer.from(body));
      emitter.emit("end");
    });
  }
  return req;
}

// =============================================================================
// MOCK CANVAS STORAGE
// =============================================================================

function createMockStorage(): CanvasStorage {
  return {
    getBySession: vi.fn(),
    save: vi.fn().mockReturnValue(true),
    delete: vi.fn(),
    listByProject: vi.fn(),
  } as unknown as CanvasStorage;
}

// =============================================================================
// SAMPLE DATA
// =============================================================================

const sampleCanvas: CanvasState = {
  id: "canvas-1",
  sessionId: "session-abc",
  userId: "user-1",
  projectFingerprint: "proj-xyz",
  shapes: JSON.stringify([{ id: "shape-1", type: "rect", x: 0, y: 0, w: 100, h: 100 }]),
  viewport: JSON.stringify({ x: 0, y: 0, zoom: 1 }),
  version: 1,
  createdAt: 1000,
  updatedAt: 2000,
};

// =============================================================================
// TESTS
// =============================================================================

describe("handleCanvasRoute", () => {
  let storage: CanvasStorage;
  let res: MockRes & ServerResponse;

  beforeEach(() => {
    storage = createMockStorage();
    res = createMockRes();
  });

  /** Parse the JSON body written to the mock response */
  function responseJson(): unknown {
    return JSON.parse((res as MockRes).body);
  }

  // ---------------------------------------------------------------------------
  // ROUTE MATCHING — fall-through
  // ---------------------------------------------------------------------------

  describe("route matching", () => {
    it("returns false for non-canvas URLs", () => {
      const req = createMockReq();
      const handled = handleCanvasRoute("/api/metrics", "GET", req, res, storage);
      expect(handled).toBe(false);
      expect(res.writeHead).not.toHaveBeenCalled();
    });

    it("returns true for any /api/canvas URL", () => {
      const req = createMockReq();
      const handled = handleCanvasRoute("/api/canvas", "GET", req, res, storage);
      expect(handled).toBe(true);
    });

    it("returns 503 when canvasStorage is undefined", () => {
      const req = createMockReq();
      const handled = handleCanvasRoute("/api/canvas/session-1", "GET", req, res, undefined);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(503);
      expect(responseJson()).toEqual({ error: "Canvas storage not available" });
    });

    it("returns 404 for unmatched sub-paths within /api/canvas", () => {
      const req = createMockReq();
      handleCanvasRoute("/api/canvas/a/b/c/d", "GET", req, res, storage);
      expect(res.statusCode).toBe(404);
      expect(responseJson()).toEqual({ error: "Canvas endpoint not found" });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/canvas/:sessionId
  // ---------------------------------------------------------------------------

  describe("GET /api/canvas/:sessionId", () => {
    it("returns canvas state for a valid session", () => {
      (storage.getBySession as ReturnType<typeof vi.fn>).mockReturnValue(sampleCanvas);

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session-abc", "GET", req, res, storage);

      expect(res.statusCode).toBe(200);
      expect(responseJson()).toEqual({ canvas: { ...sampleCanvas, version: 1 } });
      expect(storage.getBySession).toHaveBeenCalledWith("session-abc");
    });

    it("returns null canvas when session not found", () => {
      (storage.getBySession as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/nonexistent", "GET", req, res, storage);

      expect(res.statusCode).toBe(200);
      expect(responseJson()).toEqual({ canvas: null });
    });

    it("returns 500 when storage throws", () => {
      (storage.getBySession as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB failure");
      });

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session-abc", "GET", req, res, storage);

      expect(res.statusCode).toBe(500);
      expect(responseJson()).toEqual({ error: "Failed to retrieve canvas" });
    });

    it("decodes URL-encoded session IDs", () => {
      (storage.getBySession as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session%20abc", "GET", req, res, storage);

      expect(storage.getBySession).toHaveBeenCalledWith("session abc");
    });

    it("handles query parameters in URL without breaking", () => {
      (storage.getBySession as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session-abc?foo=bar", "GET", req, res, storage);

      expect(res.statusCode).toBe(200);
      expect(storage.getBySession).toHaveBeenCalledWith("session-abc");
    });
  });

  // ---------------------------------------------------------------------------
  // PUT /api/canvas/:sessionId
  // ---------------------------------------------------------------------------

  describe("PUT /api/canvas/:sessionId", () => {
    it("saves canvas state and returns success", async () => {
      const body = JSON.stringify({
        shapes: [{ id: "s1", type: "circle", cx: 50, cy: 50, r: 25 }],
        viewport: { x: 10, y: 20, zoom: 1.5 },
        userId: "user-1",
        projectFingerprint: "proj-xyz",
      });

      const req = createMockReq(body);
      const handled = handleCanvasRoute("/api/canvas/session-abc", "PUT", req, res, storage);
      expect(handled).toBe(true);

      // readJsonBody is async — wait for it
      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });

      expect(res.statusCode).toBe(200);
      expect(responseJson()).toEqual({ status: "saved", sessionId: "session-abc" });
      expect(storage.save).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-abc",
          userId: "user-1",
          projectFingerprint: "proj-xyz",
        }),
      );

      // Verify shapes are stored as a JSON string
      const savedState = (storage.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CanvasState;
      expect(typeof savedState.shapes).toBe("string");
      expect(JSON.parse(savedState.shapes)).toEqual([{ id: "s1", type: "circle", cx: 50, cy: 50, r: 25 }]);
    });

    it("handles shapes already as a string", async () => {
      const shapesArr = [{ id: "r1", type: "rect" }];
      const shapesStr = JSON.stringify(shapesArr);
      const body = JSON.stringify({ shapes: shapesStr });

      const req = createMockReq(body);
      handleCanvasRoute("/api/canvas/session-abc", "PUT", req, res, storage);

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });

      expect(res.statusCode).toBe(200);
      const savedState = (storage.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CanvasState;
      // After validation, shapes are re-serialized
      expect(JSON.parse(savedState.shapes)).toEqual(shapesArr);
    });

    it("handles viewport already as a string", async () => {
      const viewportStr = JSON.stringify({ x: 0, y: 0, zoom: 1 });
      const body = JSON.stringify({ shapes: [], viewport: viewportStr });

      const req = createMockReq(body);
      handleCanvasRoute("/api/canvas/session-abc", "PUT", req, res, storage);

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });

      const savedState = (storage.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CanvasState;
      expect(savedState.viewport).toBe(viewportStr);
    });

    it("defaults shapes to empty array when omitted", async () => {
      const body = JSON.stringify({ userId: "user-1" });

      const req = createMockReq(body);
      handleCanvasRoute("/api/canvas/session-abc", "PUT", req, res, storage);

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });

      const savedState = (storage.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CanvasState;
      expect(JSON.parse(savedState.shapes)).toEqual([]);
    });

    it("sets updatedAt to current time", async () => {
      const before = Date.now();
      const body = JSON.stringify({ shapes: [] });

      const req = createMockReq(body);
      handleCanvasRoute("/api/canvas/session-abc", "PUT", req, res, storage);

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });

      const savedState = (storage.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CanvasState;
      expect(savedState.updatedAt).toBeGreaterThanOrEqual(before);
      expect(savedState.updatedAt).toBeLessThanOrEqual(Date.now());
    });

    it("uses provided id or defaults to sessionId", async () => {
      // With custom id
      const body1 = JSON.stringify({ id: "custom-id", shapes: [] });
      const req1 = createMockReq(body1);
      handleCanvasRoute("/api/canvas/session-abc", "PUT", req1, res, storage);

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });

      const saved1 = (storage.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CanvasState;
      expect(saved1.id).toBe("custom-id");

      // Without custom id — defaults to sessionId
      const res2 = createMockRes();
      const body2 = JSON.stringify({ shapes: [] });
      const req2 = createMockReq(body2);
      handleCanvasRoute("/api/canvas/session-abc", "PUT", req2, res2, storage);

      await vi.waitFor(() => {
        expect(res2.end).toHaveBeenCalled();
      });

      const saved2 = (storage.save as ReturnType<typeof vi.fn>).mock.calls[1]![0] as CanvasState;
      expect(saved2.id).toBe("session-abc");
    });

    it("returns 400 for invalid JSON body", async () => {
      const req = createMockReq("not-valid-json{{{");
      handleCanvasRoute("/api/canvas/session-abc", "PUT", req, res, storage);

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });

      expect(res.statusCode).toBe(400);
      expect(responseJson()).toEqual({ error: "Invalid JSON body" });
      expect(storage.save).not.toHaveBeenCalled();
    });

    it("returns 413 for oversized request body", async () => {
      // Default maxBytes is 1MB; generate a body larger than that
      const largeBody = "x".repeat(1_048_577 + 100);

      const emitter = new EventEmitter();
      // Add destroy() stub since readJsonBody calls req.destroy() on oversized body
      (emitter as any).destroy = vi.fn();
      const req = emitter as unknown as IncomingMessage;

      handleCanvasRoute("/api/canvas/session-abc", "PUT", req, res, storage);

      // Emit the oversized body in chunks
      process.nextTick(() => {
        emitter.emit("data", Buffer.from(largeBody));
        // end will still fire but aborted flag should block it
        emitter.emit("end");
      });

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });

      expect(res.statusCode).toBe(413);
      expect(responseJson()).toEqual({ error: "Request body too large" });
      expect(storage.save).not.toHaveBeenCalled();
    });

    it("parses empty body as empty object", async () => {
      const req = createMockReq("");
      handleCanvasRoute("/api/canvas/session-abc", "PUT", req, res, storage);

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });

      // Empty body => parsed as {} => shapes defaults to []
      expect(res.statusCode).toBe(200);
      const savedState = (storage.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CanvasState;
      expect(JSON.parse(savedState.shapes)).toEqual([]);
    });

    it("returns 500 when storage.save throws", async () => {
      (storage.save as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB write failure");
      });

      const body = JSON.stringify({ shapes: [] });
      const req = createMockReq(body);
      handleCanvasRoute("/api/canvas/session-abc", "PUT", req, res, storage);

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });

      expect(res.statusCode).toBe(500);
      expect(responseJson()).toEqual({ error: "Failed to save canvas" });
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/canvas/:sessionId
  // ---------------------------------------------------------------------------

  describe("DELETE /api/canvas/:sessionId", () => {
    it("deletes an existing canvas and returns 'deleted'", () => {
      (storage.delete as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session-abc", "DELETE", req, res, storage);

      expect(res.statusCode).toBe(200);
      expect(responseJson()).toEqual({ status: "deleted", sessionId: "session-abc" });
      expect(storage.delete).toHaveBeenCalledWith("session-abc");
    });

    it("returns 'not_found' when canvas does not exist", () => {
      (storage.delete as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session-abc", "DELETE", req, res, storage);

      expect(res.statusCode).toBe(200);
      expect(responseJson()).toEqual({ status: "not_found", sessionId: "session-abc" });
    });

    it("returns 500 when storage.delete throws", () => {
      (storage.delete as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB failure");
      });

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session-abc", "DELETE", req, res, storage);

      expect(res.statusCode).toBe(500);
      expect(responseJson()).toEqual({ error: "Failed to delete canvas" });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/canvas/project/:fingerprint
  // ---------------------------------------------------------------------------

  describe("GET /api/canvas/project/:fingerprint", () => {
    it("lists canvases for a project", () => {
      (storage.listByProject as ReturnType<typeof vi.fn>).mockReturnValue([sampleCanvas]);

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/project/proj-xyz", "GET", req, res, storage);

      expect(res.statusCode).toBe(200);
      expect(responseJson()).toEqual({ canvases: [sampleCanvas] });
      expect(storage.listByProject).toHaveBeenCalledWith("proj-xyz");
    });

    it("returns empty array when no canvases exist for project", () => {
      (storage.listByProject as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/project/proj-xyz", "GET", req, res, storage);

      expect(res.statusCode).toBe(200);
      expect(responseJson()).toEqual({ canvases: [] });
    });

    it("decodes URL-encoded fingerprints", () => {
      (storage.listByProject as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/project/proj%20xyz", "GET", req, res, storage);

      expect(storage.listByProject).toHaveBeenCalledWith("proj xyz");
    });

    it("handles query parameters", () => {
      (storage.listByProject as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/project/proj-xyz?limit=10", "GET", req, res, storage);

      expect(res.statusCode).toBe(200);
      expect(storage.listByProject).toHaveBeenCalledWith("proj-xyz");
    });

    it("returns 500 when storage.listByProject throws", () => {
      (storage.listByProject as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB failure");
      });

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/project/proj-xyz", "GET", req, res, storage);

      expect(res.statusCode).toBe(500);
      expect(responseJson()).toEqual({ error: "Failed to list canvases" });
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/canvas/:sessionId/export
  // ---------------------------------------------------------------------------

  describe("POST /api/canvas/:sessionId/export", () => {
    it("exports canvas shapes as JSON", () => {
      (storage.getBySession as ReturnType<typeof vi.fn>).mockReturnValue(sampleCanvas);

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session-abc/export", "POST", req, res, storage);

      expect(res.statusCode).toBe(200);

      const data = responseJson() as Record<string, unknown>;
      expect(data.sessionId).toBe("session-abc");
      expect(data.shapes).toEqual([{ id: "shape-1", type: "rect", x: 0, y: 0, w: 100, h: 100 }]);
      expect(data.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
      expect(typeof data.exportedAt).toBe("number");
    });

    it("returns 404 when canvas not found for export", () => {
      (storage.getBySession as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session-abc/export", "POST", req, res, storage);

      expect(res.statusCode).toBe(404);
      expect(responseJson()).toEqual({ error: "Canvas not found" });
    });

    it("returns 500 for corrupted shapes JSON", () => {
      const canvasWithBadShapes: CanvasState = {
        ...sampleCanvas,
        shapes: "not-valid-json{{{",
      };
      (storage.getBySession as ReturnType<typeof vi.fn>).mockReturnValue(canvasWithBadShapes);

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session-abc/export", "POST", req, res, storage);

      expect(res.statusCode).toBe(500);
      const data = responseJson() as Record<string, unknown>;
      expect(data.error).toBe("Corrupted canvas state");
      expect(data.sessionId).toBe("session-abc");
    });

    it("returns null viewport when viewport is undefined", () => {
      const canvasNoViewport: CanvasState = {
        ...sampleCanvas,
        viewport: undefined,
      };
      (storage.getBySession as ReturnType<typeof vi.fn>).mockReturnValue(canvasNoViewport);

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session-abc/export", "POST", req, res, storage);

      expect(res.statusCode).toBe(200);
      const data = responseJson() as Record<string, unknown>;
      expect(data.viewport).toBeNull();
    });

    it("returns 500 when storage throws during export", () => {
      (storage.getBySession as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB failure");
      });

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session-abc/export", "POST", req, res, storage);

      expect(res.statusCode).toBe(500);
      expect(responseJson()).toEqual({ error: "Failed to export canvas" });
    });
  });

  // ---------------------------------------------------------------------------
  // SESSION ID VALIDATION — shared across endpoints
  // ---------------------------------------------------------------------------

  describe("session ID validation", () => {
    it("rejects session IDs with path traversal (..)", () => {
      const req = createMockReq();
      handleCanvasRoute("/api/canvas/../etc/passwd", "GET", req, res, storage);
      // The regex won't match this URL pattern at all — falls to 404
      expect(res.statusCode).toBe(404);
    });

    it("rejects session IDs with forward slashes via validation", () => {
      // URL encoding of "/" is %2F — after decodeURIComponent it becomes "/"
      const req = createMockReq();
      handleCanvasRoute("/api/canvas/a%2Fb", "GET", req, res, storage);

      expect(res.statusCode).toBe(400);
      expect(responseJson()).toEqual({ error: "Invalid session id" });
      expect(storage.getBySession).not.toHaveBeenCalled();
    });

    it("rejects session IDs with backslashes", () => {
      const req = createMockReq();
      handleCanvasRoute("/api/canvas/a%5Cb", "GET", req, res, storage);

      expect(res.statusCode).toBe(400);
      expect(responseJson()).toEqual({ error: "Invalid session id" });
    });

    it("rejects session IDs with null bytes", () => {
      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session%00abc", "GET", req, res, storage);

      expect(res.statusCode).toBe(400);
      expect(responseJson()).toEqual({ error: "Invalid session id" });
    });

    it("rejects session IDs with encoded path traversal (..)", () => {
      const req = createMockReq();
      handleCanvasRoute("/api/canvas/foo..bar", "GET", req, res, storage);

      expect(res.statusCode).toBe(400);
      expect(responseJson()).toEqual({ error: "Invalid session id" });
    });

    it("rejects session IDs exceeding 128 characters", () => {
      const longId = "a".repeat(129);
      const req = createMockReq();
      handleCanvasRoute(`/api/canvas/${longId}`, "GET", req, res, storage);

      expect(res.statusCode).toBe(400);
      expect(responseJson()).toEqual({ error: "Invalid session id" });
    });

    it("accepts session IDs at exactly 128 characters", () => {
      const maxId = "a".repeat(128);
      (storage.getBySession as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const req = createMockReq();
      handleCanvasRoute(`/api/canvas/${maxId}`, "GET", req, res, storage);

      expect(res.statusCode).toBe(200);
      expect(storage.getBySession).toHaveBeenCalledWith(maxId);
    });

    it("rejects invalid session IDs on PUT", async () => {
      const body = JSON.stringify({ shapes: [] });
      const req = createMockReq(body);
      handleCanvasRoute("/api/canvas/foo..bar", "PUT", req, res, storage);

      expect(res.statusCode).toBe(400);
      expect(responseJson()).toEqual({ error: "Invalid session id" });
      expect(storage.save).not.toHaveBeenCalled();
    });

    it("rejects invalid session IDs on DELETE", () => {
      const req = createMockReq();
      handleCanvasRoute("/api/canvas/foo%5Cbar", "DELETE", req, res, storage);

      expect(res.statusCode).toBe(400);
      expect(responseJson()).toEqual({ error: "Invalid session id" });
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it("rejects invalid fingerprint on project list", () => {
      const req = createMockReq();
      handleCanvasRoute("/api/canvas/project/foo..bar", "GET", req, res, storage);

      expect(res.statusCode).toBe(400);
      expect(responseJson()).toEqual({ error: "Invalid project fingerprint" });
      expect(storage.listByProject).not.toHaveBeenCalled();
    });

    it("rejects invalid session IDs on export", () => {
      const req = createMockReq();
      handleCanvasRoute("/api/canvas/foo%00bar/export", "POST", req, res, storage);

      expect(res.statusCode).toBe(400);
      expect(responseJson()).toEqual({ error: "Invalid session id" });
      expect(storage.getBySession).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // SECURITY — XSS, injection, edge cases
  // ---------------------------------------------------------------------------

  describe("security", () => {
    it("returns JSON content-type on all responses (prevents XSS)", () => {
      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session-abc", "GET", req, res, storage);

      expect(res.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
    });

    it("does not reflect raw XSS payloads in error messages", () => {
      // An attacker might try to inject script tags in the session ID
      // The validation should reject it, and even if it doesn't, responses are JSON
      const xssId = "<script>alert(1)</script>";
      const req = createMockReq();
      handleCanvasRoute(`/api/canvas/${encodeURIComponent(xssId)}`, "GET", req, res, storage);

      // Should be rejected by validation (contains path-like characters or length)
      // Even if accepted, JSON serialization prevents XSS
      const body = (res as MockRes).body;
      expect(body).not.toContain("<script>");
    });

    it("safely handles XSS in stored canvas data", () => {
      const xssCanvas: CanvasState = {
        ...sampleCanvas,
        shapes: JSON.stringify([{ id: "xss-1", type: "text", label: "<script>alert('xss')</script>" }]),
      };
      (storage.getBySession as ReturnType<typeof vi.fn>).mockReturnValue(xssCanvas);

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session-abc/export", "POST", req, res, storage);

      expect(res.statusCode).toBe(200);
      // JSON serialization escapes special characters, preventing reflection-based XSS
      expect(res.headers["Content-Type"]).toBe("application/json");
    });

    it("handles session IDs with special but valid characters", () => {
      (storage.getBySession as ReturnType<typeof vi.fn>).mockReturnValue(null);

      // Hyphens, underscores, and dots (without ..) should be valid
      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session-abc_def.123", "GET", req, res, storage);

      expect(res.statusCode).toBe(200);
      expect(storage.getBySession).toHaveBeenCalledWith("session-abc_def.123");
    });
  });

  // ---------------------------------------------------------------------------
  // METHOD ROUTING
  // ---------------------------------------------------------------------------

  describe("method routing", () => {
    it("does not match POST on the session-level endpoint", () => {
      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session-abc", "POST", req, res, storage);

      // POST on /api/canvas/:sessionId (without /export) has no handler
      // Falls through to the 404 at the bottom
      expect(res.statusCode).toBe(404);
      expect(responseJson()).toEqual({ error: "Canvas endpoint not found" });
    });

    it("does not match DELETE on the project endpoint", () => {
      const req = createMockReq();
      handleCanvasRoute("/api/canvas/project/proj-xyz", "DELETE", req, res, storage);

      // DELETE doesn't match the project route (GET only)
      // The URL also doesn't match /api/canvas/:sessionId for DELETE because
      // the regex pattern won't match "project/proj-xyz" as a single segment
      expect(res.statusCode).toBe(404);
    });

    it("does not match GET on the export endpoint", () => {
      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session-abc/export", "GET", req, res, storage);

      // GET /api/canvas/:sessionId/export — export is POST only
      // The URL doesn't match the session-level GET regex either
      expect(res.statusCode).toBe(404);
    });

    it("does not match PATCH on any endpoint", () => {
      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session-abc", "PATCH", req, res, storage);

      expect(res.statusCode).toBe(404);
      expect(responseJson()).toEqual({ error: "Canvas endpoint not found" });
    });
  });

  // ---------------------------------------------------------------------------
  // RESPONSE FORMAT
  // ---------------------------------------------------------------------------

  describe("response format", () => {
    it("all successful responses are valid JSON", () => {
      (storage.getBySession as ReturnType<typeof vi.fn>).mockReturnValue(sampleCanvas);

      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session-abc", "GET", req, res, storage);

      expect(() => JSON.parse((res as MockRes).body)).not.toThrow();
      expect(res.headers["Content-Type"]).toBe("application/json");
    });

    it("all error responses are valid JSON", () => {
      const req = createMockReq();
      handleCanvasRoute("/api/canvas/session-abc", "GET", req, res, undefined);

      expect(() => JSON.parse((res as MockRes).body)).not.toThrow();
      expect(res.headers["Content-Type"]).toBe("application/json");
    });
  });
});
