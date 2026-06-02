import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleSettingsRoutes } from "./server-settings-routes.js";
import type { RouteContext } from "./server-types.js";
import { DaemonStorage } from "../daemon/daemon-storage.js";

// =============================================================================
// HELPERS — lightweight mocks for IncomingMessage / ServerResponse
//
// The handlers under test write rate-limit and voice settings into a REAL
// temp-file SQLite DaemonStorage, so the write -> read roundtrip is genuinely
// exercised end-to-end (no storage mock). Only the HTTP req/res plumbing is
// stubbed, matching the existing canvas-routes.test.ts style.
// =============================================================================

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
 * Create a mock IncomingMessage that emits data/end events on the next tick so
 * the readJsonBody listeners attach before the body is delivered.
 */
function createMockReq(body?: string): IncomingMessage {
  const emitter = new EventEmitter();
  const req = emitter as unknown as IncomingMessage;
  if (body !== undefined) {
    process.nextTick(() => {
      emitter.emit("data", Buffer.from(body));
      emitter.emit("end");
    });
  }
  return req;
}

/**
 * Faithful re-implementation of DashboardServer.readJsonBody's contract: parse
 * the body as JSON (empty -> {}), send 400 on invalid JSON, 413 on oversize.
 * The route handlers receive this via ctx.readJsonBody.
 */
function readJsonBody<T>(req: IncomingMessage, res: ServerResponse, maxBytes = 4096): Promise<T | null> {
  return new Promise((resolve) => {
    let body = "";
    let bodyBytes = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      bodyBytes += chunk.length;
      if (bodyBytes > maxBytes) {
        aborted = true;
        req.destroy();
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
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
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        resolve(null);
      }
    });
  });
}

/**
 * Build a minimal RouteContext carrying the real DaemonStorage plus the
 * readJsonBody shim. Only the fields the settings handlers touch are populated;
 * the rest are cast away since the handlers never read them.
 */
function makeCtx(storage?: DaemonStorage): RouteContext {
  return {
    daemonStorage: storage,
    readJsonBody,
  } as unknown as RouteContext;
}

// =============================================================================
// TESTS
// =============================================================================

describe("handleSettingsRoutes", () => {
  let storage: DaemonStorage;
  let tmpDir: string;
  let res: MockRes & ServerResponse;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "settings-routes-test-"));
    storage = new DaemonStorage(join(tmpDir, "daemon.db"));
    storage.initialize();
    res = createMockRes();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function responseJson(): unknown {
    return JSON.parse((res as MockRes).body);
  }

  // ---------------------------------------------------------------------------
  // ROUTE MATCHING — fall-through
  // ---------------------------------------------------------------------------

  describe("route matching", () => {
    it("returns false for unrelated URLs", () => {
      const req = createMockReq();
      const handled = handleSettingsRoutes("/api/metrics", "GET", req, res, makeCtx(storage));
      expect(handled).toBe(false);
      expect(res.writeHead).not.toHaveBeenCalled();
    });

    it("returns 503 for rate-limits GET when storage is unavailable", () => {
      const req = createMockReq();
      const handled = handleSettingsRoutes("/api/settings/rate-limits", "GET", req, res, makeCtx(undefined));
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(503);
      expect(responseJson()).toEqual({ error: "Storage not available" });
    });

    it("returns 503 for voice when storage is unavailable", () => {
      const req = createMockReq();
      const handled = handleSettingsRoutes("/api/settings/voice", "GET", req, res, makeCtx(undefined));
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(503);
      expect(responseJson()).toEqual({ error: "Storage not available" });
    });
  });

  // ---------------------------------------------------------------------------
  // RATE LIMITS — GET defaults + POST -> GET roundtrip against real SQLite
  // ---------------------------------------------------------------------------

  describe("rate limits", () => {
    it("GET returns zeros when no overrides have been written", () => {
      const req = createMockReq();
      const handled = handleSettingsRoutes("/api/settings/rate-limits", "GET", req, res, makeCtx(storage));
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(responseJson()).toEqual({
        messagesPerMinute: 0,
        messagesPerHour: 0,
        tokensPerDay: 0,
      });
    });

    it("POST persists overrides that a subsequent GET reads back (real DB roundtrip)", async () => {
      const body = JSON.stringify({
        messagesPerMinute: 30,
        messagesPerHour: 500,
        tokensPerDay: 100000,
      });
      const postReq = createMockReq(body);
      handleSettingsRoutes("/api/settings/rate-limits", "POST", postReq, res, makeCtx(storage));

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });
      expect(res.statusCode).toBe(200);
      expect(responseJson()).toEqual({ success: true });

      // Values were genuinely written to SQLite.
      expect(storage.getSettingsOverride("rate_limit_messages_per_minute")).toBe("30");
      expect(storage.getSettingsOverride("rate_limit_messages_per_hour")).toBe("500");
      expect(storage.getSettingsOverride("rate_limit_tokens_per_day")).toBe("100000");

      // And the GET handler reads them back as numbers.
      const getRes = createMockRes();
      const getReq = createMockReq();
      handleSettingsRoutes("/api/settings/rate-limits", "GET", getReq, getRes, makeCtx(storage));
      expect(getRes.statusCode).toBe(200);
      expect(JSON.parse((getRes as MockRes).body)).toEqual({
        messagesPerMinute: 30,
        messagesPerHour: 500,
        tokensPerDay: 100000,
      });
    });

    it("POST only updates the fields present in the body", async () => {
      // Seed all three.
      storage.setSettingsOverride("rate_limit_messages_per_minute", "10");
      storage.setSettingsOverride("rate_limit_messages_per_hour", "20");
      storage.setSettingsOverride("rate_limit_tokens_per_day", "30");

      const body = JSON.stringify({ messagesPerMinute: 99 });
      const postReq = createMockReq(body);
      handleSettingsRoutes("/api/settings/rate-limits", "POST", postReq, res, makeCtx(storage));

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });

      expect(storage.getSettingsOverride("rate_limit_messages_per_minute")).toBe("99");
      // Untouched fields keep their seeded values.
      expect(storage.getSettingsOverride("rate_limit_messages_per_hour")).toBe("20");
      expect(storage.getSettingsOverride("rate_limit_tokens_per_day")).toBe("30");
    });

    it("tokensPerDay round-trips through the same key the GET handler reads", async () => {
      // Regression guard: POST must write the rate_limit_tokens_per_day key so
      // the daily field survives a reload instead of reverting to 0.
      const body = JSON.stringify({ tokensPerDay: 250000 });
      const postReq = createMockReq(body);
      handleSettingsRoutes("/api/settings/rate-limits", "POST", postReq, res, makeCtx(storage));

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });

      const getRes = createMockRes();
      const getReq = createMockReq();
      handleSettingsRoutes("/api/settings/rate-limits", "GET", getReq, getRes, makeCtx(storage));
      expect((JSON.parse((getRes as MockRes).body) as { tokensPerDay: number }).tokensPerDay).toBe(250000);
    });

    it("returns 400 for an invalid JSON body on POST", async () => {
      const postReq = createMockReq("not-json{{{");
      handleSettingsRoutes("/api/settings/rate-limits", "POST", postReq, res, makeCtx(storage));

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });
      expect(res.statusCode).toBe(400);
      expect(responseJson()).toEqual({ error: "Invalid JSON body" });
    });
  });

  // ---------------------------------------------------------------------------
  // VOICE — per-chatId scope GET/POST roundtrip against real SQLite
  // ---------------------------------------------------------------------------

  describe("voice settings", () => {
    it("GET returns nulls (with default global chatId) when nothing is stored", () => {
      const req = createMockReq();
      handleSettingsRoutes("/api/settings/voice", "GET", req, res, makeCtx(storage));
      expect(res.statusCode).toBe(200);
      expect(responseJson()).toEqual({
        enabled: null,
        language: null,
        speed: null,
        chatId: "global",
      });
    });

    it("POST persists voice settings that a subsequent GET reads back (real DB roundtrip)", async () => {
      const body = JSON.stringify({ enabled: true, language: "tr", speed: 1.25 });
      const postReq = createMockReq(body);
      handleSettingsRoutes("/api/settings/voice?chatId=chat-alice", "POST", postReq, res, makeCtx(storage));

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });
      expect(res.statusCode).toBe(200);
      expect(responseJson()).toEqual({ success: true });

      // Stored as strings in the alice scope.
      expect(storage.getSettingsOverride("voice_enabled", "chat-alice")).toBe("true");
      expect(storage.getSettingsOverride("voice_language", "chat-alice")).toBe("tr");
      expect(storage.getSettingsOverride("voice_speed", "chat-alice")).toBe("1.25");

      // GET reads them back with correct types.
      const getRes = createMockRes();
      const getReq = createMockReq();
      handleSettingsRoutes("/api/settings/voice?chatId=chat-alice", "GET", getReq, getRes, makeCtx(storage));
      expect(getRes.statusCode).toBe(200);
      expect(JSON.parse((getRes as MockRes).body)).toEqual({
        enabled: true,
        language: "tr",
        speed: 1.25,
        chatId: "chat-alice",
      });
    });

    it("isolates voice settings per chatId scope", async () => {
      const aliceReq = createMockReq(JSON.stringify({ enabled: true, language: "tr" }));
      handleSettingsRoutes("/api/settings/voice?chatId=chat-alice", "POST", aliceReq, res, makeCtx(storage));
      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });

      const bobRes = createMockRes();
      const bobReq = createMockReq(JSON.stringify({ enabled: false, language: "en" }));
      handleSettingsRoutes("/api/settings/voice?chatId=chat-bob", "POST", bobReq, bobRes, makeCtx(storage));
      await vi.waitFor(() => {
        expect(bobRes.end).toHaveBeenCalled();
      });

      // Read alice back.
      const aliceGetRes = createMockRes();
      handleSettingsRoutes(
        "/api/settings/voice?chatId=chat-alice",
        "GET",
        createMockReq(),
        aliceGetRes,
        makeCtx(storage),
      );
      expect(JSON.parse((aliceGetRes as MockRes).body)).toMatchObject({
        enabled: true,
        language: "tr",
        chatId: "chat-alice",
      });

      // Read bob back — independent values.
      const bobGetRes = createMockRes();
      handleSettingsRoutes(
        "/api/settings/voice?chatId=chat-bob",
        "GET",
        createMockReq(),
        bobGetRes,
        makeCtx(storage),
      );
      expect(JSON.parse((bobGetRes as MockRes).body)).toMatchObject({
        enabled: false,
        language: "en",
        chatId: "chat-bob",
      });

      // The default (global) scope was never written.
      const globalGetRes = createMockRes();
      handleSettingsRoutes("/api/settings/voice", "GET", createMockReq(), globalGetRes, makeCtx(storage));
      expect(JSON.parse((globalGetRes as MockRes).body)).toEqual({
        enabled: null,
        language: null,
        speed: null,
        chatId: "global",
      });
    });

    it("POST only updates the voice fields present in the body", async () => {
      storage.setSettingsOverride("voice_enabled", "true", "chat-alice");
      storage.setSettingsOverride("voice_language", "tr", "chat-alice");
      storage.setSettingsOverride("voice_speed", "1.0", "chat-alice");

      const postReq = createMockReq(JSON.stringify({ speed: 2.0 }));
      handleSettingsRoutes("/api/settings/voice?chatId=chat-alice", "POST", postReq, res, makeCtx(storage));
      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });

      expect(storage.getSettingsOverride("voice_speed", "chat-alice")).toBe("2");
      expect(storage.getSettingsOverride("voice_enabled", "chat-alice")).toBe("true");
      expect(storage.getSettingsOverride("voice_language", "chat-alice")).toBe("tr");
    });

    it("coerces enabled to a boolean string regardless of truthy input", async () => {
      const postReq = createMockReq(JSON.stringify({ enabled: 1 }));
      handleSettingsRoutes("/api/settings/voice?chatId=chat-x", "POST", postReq, res, makeCtx(storage));
      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });
      expect(storage.getSettingsOverride("voice_enabled", "chat-x")).toBe("true");
    });

    it("returns 405 for unsupported methods on the voice route", () => {
      const req = createMockReq();
      handleSettingsRoutes("/api/settings/voice", "PUT", req, res, makeCtx(storage));
      expect(res.statusCode).toBe(405);
      expect(responseJson()).toEqual({ error: "Method not allowed" });
    });

    it("returns 400 for an invalid JSON body on voice POST", async () => {
      const postReq = createMockReq("nope{{{");
      handleSettingsRoutes("/api/settings/voice?chatId=chat-x", "POST", postReq, res, makeCtx(storage));
      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });
      expect(res.statusCode).toBe(400);
      expect(responseJson()).toEqual({ error: "Invalid JSON body" });
    });
  });

  // ---------------------------------------------------------------------------
  // DURABILITY across "restart" — POST writes survive close + reopen of the
  // same DB file and are readable by GET on a fresh DaemonStorage.
  // ---------------------------------------------------------------------------

  describe("durability across restart", () => {
    it("rate-limit overrides written via POST survive a close + reopen of the same DB file", async () => {
      const dbPath = join(tmpDir, "daemon.db");
      // Write via the route handler against the existing (beforeEach) storage.
      const postReq = createMockReq(JSON.stringify({ messagesPerMinute: 77, tokensPerDay: 888 }));
      handleSettingsRoutes("/api/settings/rate-limits", "POST", postReq, res, makeCtx(storage));
      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled();
      });

      // Simulate a daemon restart: close this connection, open a new one on the
      // SAME file, and serve a GET from the fresh DaemonStorage.
      storage.close();
      const reopened = new DaemonStorage(dbPath);
      reopened.initialize();
      try {
        const getRes = createMockRes();
        handleSettingsRoutes("/api/settings/rate-limits", "GET", createMockReq(), getRes, makeCtx(reopened));
        expect(getRes.statusCode).toBe(200);
        expect(JSON.parse((getRes as MockRes).body)).toMatchObject({
          messagesPerMinute: 77,
          tokensPerDay: 888,
        });
      } finally {
        reopened.close();
        // Re-open the original handle so afterEach's close() is safe.
        storage = new DaemonStorage(dbPath);
        storage.initialize();
      }
    });
  });
});
