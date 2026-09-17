import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleSettingsRoutes } from "./server-settings-routes.js";
import {
  createMockReq,
  createMockRes,
  flushAsync,
  responseJson,
  type MockRes,
} from "./test-support/mock-http.js";
import type { RouteContext } from "./server-types.js";
import { DaemonStorage } from "../daemon/daemon-storage.js";
import { RateLimiter } from "../security/rate-limiter.js";

// =============================================================================
// MOCK STORAGE — in-memory settings overrides keyed by `${key}::${scope}`
// =============================================================================

interface MockStorage {
  store: Map<string, string>;
  getSettingsOverride: (key: string, scope?: string) => string | undefined;
  setSettingsOverride: (key: string, value: string, scope?: string) => void;
}

function createMockStorage(): MockStorage {
  const store = new Map<string, string>();
  return {
    store,
    getSettingsOverride: (key: string, scope = "global") => store.get(`${key}::${scope}`),
    setSettingsOverride: (key: string, value: string, scope = "global") => {
      store.set(`${key}::${scope}`, value);
    },
  };
}

// =============================================================================
// MOCK ROUTE CONTEXT
// =============================================================================

function createCtx(storage: MockStorage, body?: unknown): RouteContext {
  return {
    daemonStorage: storage,
    readJsonBody: vi.fn().mockResolvedValue(body ?? null),
  } as unknown as RouteContext;
}

// =============================================================================
// REAL-STORAGE HELPERS — real DaemonStorage + a faithful readJsonBody shim
//
// The real-DB suites below exercise the write -> read roundtrip end-to-end
// against a temp-file SQLite DaemonStorage (no storage mock). Only the HTTP
// req/res plumbing is stubbed (reusing the shared mock-http harness).
// =============================================================================

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

/** makeCtx plus the running limiter a POST is supposed to drive (item 2.7). */
function makeCtxWithLimiter(storage: DaemonStorage, rateLimiter: RateLimiter): RouteContext {
  return {
    daemonStorage: storage,
    rateLimiter,
    readJsonBody,
  } as unknown as RouteContext;
}

// =============================================================================
// TESTS
// =============================================================================

describe("handleSettingsRoutes — /api/settings/voice", () => {
  let storage: MockStorage;
  let res: MockRes & ServerResponse;

  beforeEach(() => {
    storage = createMockStorage();
    res = createMockRes();
  });

  it("GET with empty storage returns null voice fields and global scope", () => {
    const handled = handleSettingsRoutes("/api/settings/voice", "GET", createMockReq(), res, createCtx(storage));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toEqual({
      enabled: null,
      language: null,
      speed: null,
      inputEnabled: null,
      outputEnabled: null,
      browserSttEnabled: null,
      chatId: "global",
    });
  });

  it("POST persists portal voice fields under global scope", async () => {
    const ctx = createCtx(storage, { inputEnabled: false, outputEnabled: true, browserSttEnabled: true });
    const handled = handleSettingsRoutes("/api/settings/voice", "POST", createMockReq(), res, ctx);
    expect(handled).toBe(true);
    await flushAsync();

    expect(responseJson(res)).toEqual({ success: true });
    expect(storage.store.get("voice_input_enabled::global")).toBe("false");
    expect(storage.store.get("voice_output_enabled::global")).toBe("true");
    expect(storage.store.get("voice_browser_stt_enabled::global")).toBe("true");
  });

  it("GET after POST round-trips the portal voice fields", async () => {
    const postCtx = createCtx(storage, { inputEnabled: false, outputEnabled: true, browserSttEnabled: true });
    handleSettingsRoutes("/api/settings/voice", "POST", createMockReq(), createMockRes(), postCtx);
    await flushAsync();

    handleSettingsRoutes("/api/settings/voice", "GET", createMockReq(), res, createCtx(storage));
    expect(responseJson(res)).toMatchObject({
      inputEnabled: false,
      outputEnabled: true,
      browserSttEnabled: true,
      chatId: "global",
    });
  });

  it("POST with ?chatId=abc persists under that scope without touching global", async () => {
    const postCtx = createCtx(storage, { inputEnabled: true, outputEnabled: false, browserSttEnabled: true });
    handleSettingsRoutes("/api/settings/voice?chatId=abc", "POST", createMockReq(), createMockRes(), postCtx);
    await flushAsync();

    expect(storage.store.get("voice_input_enabled::abc")).toBe("true");
    expect(storage.store.get("voice_input_enabled::global")).toBeUndefined();

    // GET with ?chatId=abc reads the scoped values back
    handleSettingsRoutes("/api/settings/voice?chatId=abc", "GET", createMockReq(), res, createCtx(storage));
    expect(responseJson(res)).toMatchObject({
      inputEnabled: true,
      outputEnabled: false,
      browserSttEnabled: true,
      chatId: "abc",
    });

    // Plain GET (global scope) still returns nulls
    const globalRes = createMockRes();
    handleSettingsRoutes("/api/settings/voice", "GET", createMockReq(), globalRes, createCtx(storage));
    expect(responseJson(globalRes)).toMatchObject({
      inputEnabled: null,
      outputEnabled: null,
      browserSttEnabled: null,
      chatId: "global",
    });
  });

  it("legacy enabled/language/speed fields still persist and read back", async () => {
    const postCtx = createCtx(storage, { enabled: true, language: "tr", speed: 1.25 });
    handleSettingsRoutes("/api/settings/voice", "POST", createMockReq(), createMockRes(), postCtx);
    await flushAsync();

    expect(storage.store.get("voice_enabled::global")).toBe("true");
    expect(storage.store.get("voice_language::global")).toBe("tr");
    expect(storage.store.get("voice_speed::global")).toBe("1.25");

    handleSettingsRoutes("/api/settings/voice", "GET", createMockReq(), res, createCtx(storage));
    expect(responseJson(res)).toMatchObject({
      enabled: true,
      language: "tr",
      speed: 1.25,
    });
  });

  it("ignores non-boolean values for the portal voice fields", async () => {
    const ctx = createCtx(storage, { inputEnabled: "yes", outputEnabled: 1, browserSttEnabled: null });
    handleSettingsRoutes("/api/settings/voice", "POST", createMockReq(), res, ctx);
    await flushAsync();

    expect(responseJson(res)).toEqual({ success: true });
    expect(storage.store.has("voice_input_enabled::global")).toBe(false);
    expect(storage.store.has("voice_output_enabled::global")).toBe(false);
    expect(storage.store.has("voice_browser_stt_enabled::global")).toBe(false);
  });

  it("returns 405 for unsupported methods", () => {
    const handled = handleSettingsRoutes("/api/settings/voice", "PUT", createMockReq(), res, createCtx(storage));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(responseJson(res)).toEqual({ error: "Method not allowed" });
  });

  it("returns 503 when storage is unavailable", () => {
    const ctx = { daemonStorage: undefined, readJsonBody: vi.fn() } as unknown as RouteContext;
    const handled = handleSettingsRoutes("/api/settings/voice", "GET", createMockReq(), res, ctx);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
  });
});

// =============================================================================
// FAKE BUDGET MANAGER — for /api/budget* routes
// =============================================================================

interface FakeBudgetManager {
  getSnapshot: ReturnType<typeof vi.fn>;
  getConfig: ReturnType<typeof vi.fn>;
  getDailyHistory: ReturnType<typeof vi.fn>;
  updateConfig: ReturnType<typeof vi.fn>;
}

function createFakeBudgetManager(): FakeBudgetManager {
  return {
    getSnapshot: vi.fn(() => ({ spentUsd: 1.5, remainingUsd: 8.5 })),
    getConfig: vi.fn(() => ({ dailyLimitUsd: 10 })),
    getDailyHistory: vi.fn(() => []),
    updateConfig: vi.fn(),
  };
}

function budgetCtx(manager?: FakeBudgetManager, body?: unknown): RouteContext {
  return {
    unifiedBudgetManager: manager,
    readJsonBody: vi.fn().mockResolvedValue(body ?? null),
  } as unknown as RouteContext;
}

// =============================================================================
// TESTS — fall-through + budget + rate-limits
// =============================================================================

describe("handleSettingsRoutes — fall-through", () => {
  it("returns false for an unmatched URL", () => {
    const res = createMockRes();
    const handled = handleSettingsRoutes("/api/unknown", "GET", createMockReq(), res, budgetCtx());
    expect(handled).toBe(false);
    expect(res.end).not.toHaveBeenCalled();
  });
});

describe("handleSettingsRoutes — GET /api/budget", () => {
  it("returns 503 without a budget manager", () => {
    const res = createMockRes();
    const handled = handleSettingsRoutes("/api/budget", "GET", createMockReq(), res, budgetCtx());
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(responseJson(res)).toEqual({ error: "Budget manager not available" });
  });

  it("merges the snapshot with the config", () => {
    const res = createMockRes();
    handleSettingsRoutes("/api/budget", "GET", createMockReq(), res, budgetCtx(createFakeBudgetManager()));
    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toEqual({ spentUsd: 1.5, remainingUsd: 8.5, config: { dailyLimitUsd: 10 } });
  });

  it("maps a snapshot failure to 500", () => {
    const manager = createFakeBudgetManager();
    manager.getSnapshot.mockImplementation(() => { throw new Error("snapshot boom"); });
    const res = createMockRes();
    handleSettingsRoutes("/api/budget", "GET", createMockReq(), res, budgetCtx(manager));
    expect(res.statusCode).toBe(500);
    expect(responseJson(res)).toEqual({ error: "snapshot boom" });
  });
});

describe("handleSettingsRoutes — GET /api/budget/history", () => {
  it.each([
    ["clamps ?days=99 to 30", "/api/budget/history?days=99", 30],
    ["clamps ?days=0 to 1", "/api/budget/history?days=0", 1],
    ["defaults a missing param to 7", "/api/budget/history", 7],
  ])("%s", (_label, url, expectedDays) => {
    const manager = createFakeBudgetManager();
    const res = createMockRes();
    const handled = handleSettingsRoutes(url, "GET", createMockReq(), res, budgetCtx(manager));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(manager.getDailyHistory).toHaveBeenCalledWith(expectedDays);
    expect(responseJson(res)).toEqual({ entries: [] });
  });
});

describe("handleSettingsRoutes — POST /api/budget/config", () => {
  it("updates the config and echoes the stored config", async () => {
    const manager = createFakeBudgetManager();
    const res = createMockRes();
    handleSettingsRoutes(
      "/api/budget/config", "POST", createMockReq(), res, budgetCtx(manager, { dailyLimitUsd: 25 }),
    );
    await flushAsync();
    expect(manager.updateConfig).toHaveBeenCalledWith({ dailyLimitUsd: 25 });
    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toEqual({ success: true, config: { dailyLimitUsd: 10 } });
  });

  it("maps an updateConfig failure to 400", async () => {
    const manager = createFakeBudgetManager();
    manager.updateConfig.mockImplementation(() => { throw new Error("invalid config"); });
    const res = createMockRes();
    handleSettingsRoutes("/api/budget/config", "POST", createMockReq(), res, budgetCtx(manager, {}));
    await flushAsync();
    expect(res.statusCode).toBe(400);
    expect(responseJson(res)).toEqual({ error: "invalid config" });
  });
});

describe("handleSettingsRoutes — /api/settings/rate-limits", () => {
  it("GET returns 503 without storage", () => {
    const res = createMockRes();
    const handled = handleSettingsRoutes("/api/settings/rate-limits", "GET", createMockReq(), res, budgetCtx());
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(responseJson(res)).toEqual({ error: "Storage not available" });
  });

  it("GET returns numeric zero defaults when no overrides exist", () => {
    const res = createMockRes();
    handleSettingsRoutes(
      "/api/settings/rate-limits", "GET", createMockReq(), res, createCtx(createMockStorage()),
    );
    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toEqual({ messagesPerMinute: 0, messagesPerHour: 0, tokensPerDay: 0 });
  });

  it("POST persists only the provided keys", async () => {
    const storage = createMockStorage();
    const res = createMockRes();
    handleSettingsRoutes(
      "/api/settings/rate-limits", "POST", createMockReq(), res,
      createCtx(storage, { messagesPerMinute: 5 }),
    );
    await flushAsync();
    expect(responseJson(res)).toEqual({ success: true });
    expect(storage.store.get("rate_limit_messages_per_minute::global")).toBe("5");
    expect(storage.store.size).toBe(1);
  });
});

// =============================================================================
// REAL-DB SUITE — write -> read roundtrip against a temp-file SQLite DaemonStorage
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
        inputEnabled: null,
        outputEnabled: null,
        browserSttEnabled: null,
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
        // Portal voice fields were never written by this POST, so they default to null.
        inputEnabled: null,
        outputEnabled: null,
        browserSttEnabled: null,
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
        inputEnabled: null,
        outputEnabled: null,
        browserSttEnabled: null,
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

// =============================================================================
// ITEM 2.7 — the rate-limit POST must VALIDATE and must reach the LIVE limiter
//
// Before this suite the handler stringified whatever arrived
// (`String(parsed.messagesPerMinute)`), so "abc", -5 and 1e15 were all stored
// as the enforced limit, and nothing told the running RateLimiter that its
// numbers had changed — the new value only took effect on the next restart,
// and even then nothing read it back.
// =============================================================================

describe("rate-limit settings are validated and drive the live limiter (item 2.7)", () => {
  let storage: DaemonStorage;
  let tmpDir: string;
  let res: MockRes & ServerResponse;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rate-limit-live-"));
    storage = new DaemonStorage(join(tmpDir, "daemon.db"));
    storage.initialize();
    res = createMockRes();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const post = async (body: unknown, ctx: RouteContext): Promise<void> => {
    handleSettingsRoutes("/api/settings/rate-limits", "POST", createMockReq(JSON.stringify(body)), res, ctx);
    await vi.waitFor(() => {
      expect(res.end).toHaveBeenCalled();
    });
  };

  for (const [label, body, field] of [
    ["a negative limit", { messagesPerMinute: -5 }, "messagesPerMinute"],
    ["a non-numeric limit", { tokensPerDay: "abc" }, "tokensPerDay"],
    ["an absurd limit", { messagesPerHour: 1e15 }, "messagesPerHour"],
    ["a fractional limit", { messagesPerMinute: 2.5 }, "messagesPerMinute"],
    ["a boolean limit", { messagesPerMinute: true }, "messagesPerMinute"],
    ["NaN", { tokensPerDay: "NaN" }, "tokensPerDay"],
  ] as Array<[string, Record<string, unknown>, string]>) {
    it(`refuses ${label} with a 400 that names the field and changes nothing`, async () => {
      const limiter = new RateLimiter({ messagesPerMinute: 4, messagesPerHour: 40, tokensPerDay: 400 });
      const before = limiter.getConfig();
      await post(body, makeCtxWithLimiter(storage, limiter));

      expect(res.statusCode).toBe(400);
      expect(String((responseJson(res) as { error?: string }).error)).toContain(field);
      // Nothing was stored…
      expect(storage.getSettingsOverride("rate_limit_messages_per_minute")).toBeUndefined();
      expect(storage.getSettingsOverride("rate_limit_messages_per_hour")).toBeUndefined();
      expect(storage.getSettingsOverride("rate_limit_tokens_per_day")).toBeUndefined();
      // …and the running limiter still enforces what it did before.
      expect(limiter.getConfig()).toEqual(before);
    });
  }

  it("refuses a bad value with NO limiter wired — the route validates, not only the limiter", async () => {
    // The dashboard can be up before (or without) a rate limiter. With the
    // route trusting the limiter to object, this body was persisted verbatim
    // and became the enforced limit at the next boot.
    await post({ messagesPerMinute: -5, tokensPerDay: "abc" }, makeCtx(storage));
    expect(res.statusCode).toBe(400);
    expect(String((responseJson(res) as { error?: string }).error)).toContain("messagesPerMinute");
    expect(storage.getSettingsOverride("rate_limit_messages_per_minute")).toBeUndefined();
    expect(storage.getSettingsOverride("rate_limit_tokens_per_day")).toBeUndefined();
  });

  it("refuses the WHOLE body when one field of several is bad (no partial write)", async () => {
    const limiter = new RateLimiter({ messagesPerMinute: 4 });
    await post({ messagesPerMinute: 9, tokensPerDay: -1 }, makeCtxWithLimiter(storage, limiter));
    expect(res.statusCode).toBe(400);
    expect(storage.getSettingsOverride("rate_limit_messages_per_minute")).toBeUndefined();
    expect(limiter.getConfig().messagesPerMinute).toBe(4);
  });

  it("a good POST changes what the limiter actually enforces", async () => {
    // Unlimited to begin with: without the fix the third message is allowed.
    const limiter = new RateLimiter({ messagesPerMinute: 0 });
    await post({ messagesPerMinute: 2 }, makeCtxWithLimiter(storage, limiter));
    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toMatchObject({ success: true });

    expect(limiter.checkMessageRate("u1").allowed).toBe(true);
    expect(limiter.checkMessageRate("u1").allowed).toBe(true);
    const third = limiter.checkMessageRate("u1");
    expect(third.allowed).toBe(false);
    expect(third.reason).toContain("2 messages/minute");
  });

  it("a good POST also relaxes a limit on the live limiter", async () => {
    const limiter = new RateLimiter({ messagesPerMinute: 1 });
    expect(limiter.checkMessageRate("u2").allowed).toBe(true);
    expect(limiter.checkMessageRate("u2").allowed).toBe(false);
    await post({ messagesPerMinute: 5 }, makeCtxWithLimiter(storage, limiter));
    expect(res.statusCode).toBe(200);
    expect(limiter.checkMessageRate("u2").allowed).toBe(true);
  });

  it("GUARD: a valid POST still persists every field and still works with no limiter wired", async () => {
    await post({ messagesPerMinute: 30, messagesPerHour: 500, tokensPerDay: 100000 }, makeCtx(storage));
    expect(res.statusCode).toBe(200);
    expect(storage.getSettingsOverride("rate_limit_messages_per_minute")).toBe("30");
    expect(storage.getSettingsOverride("rate_limit_messages_per_hour")).toBe("500");
    expect(storage.getSettingsOverride("rate_limit_tokens_per_day")).toBe("100000");
  });

  it("GUARD: zero stays legal — it is how the UI says 'unlimited'", async () => {
    const limiter = new RateLimiter({ messagesPerMinute: 3 });
    await post({ messagesPerMinute: 0, messagesPerHour: 0, tokensPerDay: 0 }, makeCtxWithLimiter(storage, limiter));
    expect(res.statusCode).toBe(200);
    expect(storage.getSettingsOverride("rate_limit_messages_per_minute")).toBe("0");
    expect(limiter.getConfig().messagesPerMinute).toBe(0);
    for (let i = 0; i < 10; i++) expect(limiter.checkMessageRate("u3").allowed).toBe(true);
  });

  it("GUARD: a numeric string from an API client is accepted as the number it is", async () => {
    const limiter = new RateLimiter({ messagesPerMinute: 0 });
    await post({ messagesPerMinute: "7" }, makeCtxWithLimiter(storage, limiter));
    expect(res.statusCode).toBe(200);
    expect(storage.getSettingsOverride("rate_limit_messages_per_minute")).toBe("7");
    expect(limiter.getConfig().messagesPerMinute).toBe(7);
  });
});

// =============================================================================
// ROUND 9 #22 / #23 — the GET must report the EFFECTIVE limits, and a failed
// POST must change neither the store nor the running policy.
//
// #22: with limits coming from configuration and no stored override, GET
// answered zeros. The portal loads that body, the person edits ONE field, and
// the whole-body POST writes zeros over the other two — every message limit
// disabled by editing the token quota.
//
// #23: the POST published to the live limiter FIRST and then wrote the rows one
// by one. A failure on the second write left the response an error, both live
// limits already changed, and only the first override persisted — a third
// configuration appeared at the next restart.
// =============================================================================
describe("rate-limit settings report and commit as one (round 9 #22, #23)", () => {
  let storage: DaemonStorage;
  let tmpDir: string;
  let res: MockRes & ServerResponse;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rate-limit-effective-"));
    storage = new DaemonStorage(join(tmpDir, "daemon.db"));
    storage.initialize();
    res = createMockRes();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const get = (ctx: RouteContext): Record<string, number> => {
    const getRes = createMockRes();
    handleSettingsRoutes("/api/settings/rate-limits", "GET", createMockReq(), getRes, ctx);
    return JSON.parse((getRes as MockRes).body) as Record<string, number>;
  };

  const post = async (body: unknown, ctx: RouteContext): Promise<void> => {
    handleSettingsRoutes("/api/settings/rate-limits", "POST", createMockReq(JSON.stringify(body)), res, ctx);
    await vi.waitFor(() => {
      expect(res.end).toHaveBeenCalled();
    });
  };

  it("GET returns the limits the running limiter enforces, not zeros (#22)", () => {
    const limiter = new RateLimiter({ messagesPerMinute: 10, messagesPerHour: 100, tokensPerDay: 500_000 });
    expect(get(makeCtxWithLimiter(storage, limiter))).toEqual({
      messagesPerMinute: 10,
      messagesPerHour: 100,
      tokensPerDay: 500_000,
    });
  });

  it("editing one field in the portal leaves every other limit enforced (#22)", async () => {
    const limiter = new RateLimiter({ messagesPerMinute: 10, messagesPerHour: 100, tokensPerDay: 0 });
    // Exactly what the portal does: load the form, change one field, send it all back.
    const loaded = get(makeCtxWithLimiter(storage, limiter));
    await post({ ...loaded, tokensPerDay: 250_000 }, makeCtxWithLimiter(storage, limiter));

    expect(res.statusCode).toBe(200);
    expect(limiter.getConfig()).toMatchObject({ messagesPerMinute: 10, messagesPerHour: 100, tokensPerDay: 250_000 });
    expect(storage.getSettingsOverride("rate_limit_messages_per_minute")).toBe("10");
    expect(storage.getSettingsOverride("rate_limit_messages_per_hour")).toBe("100");
  });

  it("GET falls back to the stored override when no limiter is wired (guard)", () => {
    storage.setSettingsOverride("rate_limit_messages_per_minute", "30");
    expect(get(makeCtx(storage))).toEqual({ messagesPerMinute: 30, messagesPerHour: 0, tokensPerDay: 0 });
  });

  it("GET ignores a corrupt stored override rather than reporting it as a limit (guard)", () => {
    storage.setSettingsOverride("rate_limit_messages_per_hour", "not-a-number");
    expect(get(makeCtx(storage)).messagesPerHour).toBe(0);
  });

  it("a storage failure part-way through leaves BOTH the store and the live policy unchanged (#23)", async () => {
    const limiter = new RateLimiter({ messagesPerMinute: 4, messagesPerHour: 40, tokensPerDay: 400 });
    const before = limiter.getConfig();
    let writes = 0;
    // The second row refuses to be written (a disk error, a locked DB).
    const flaky = {
      getSettingsOverride: (key: string, scope?: string) => storage.getSettingsOverride(key, scope),
      setSettingsOverride: (key: string, value: string, scope?: string) => {
        writes += 1;
        if (writes === 2) throw new Error("database is locked");
        storage.setSettingsOverride(key, value, scope);
      },
      budgetTransaction: <T>(work: () => T): T => storage.budgetTransaction(work),
    };
    await post({ messagesPerMinute: 30, messagesPerHour: 500 }, {
      daemonStorage: flaky,
      rateLimiter: limiter,
      readJsonBody,
    } as unknown as RouteContext);

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    // Nothing persisted — not even the write that succeeded.
    expect(storage.getSettingsOverride("rate_limit_messages_per_minute")).toBeUndefined();
    expect(storage.getSettingsOverride("rate_limit_messages_per_hour")).toBeUndefined();
    // And the running limiter still enforces exactly what it did before.
    expect(limiter.getConfig()).toEqual(before);
  });

  it("a store with no transaction support puts back what each row said (#23)", async () => {
    const limiter = new RateLimiter({ messagesPerMinute: 4, messagesPerHour: 40 });
    const mock = createMockStorage();
    mock.store.set("rate_limit_messages_per_minute::global", "11");
    mock.store.set("rate_limit_messages_per_hour::global", "22");
    let writes = 0;
    const flaky: MockStorage = {
      ...mock,
      setSettingsOverride: (key: string, value: string, scope = "global") => {
        writes += 1;
        if (writes === 2) throw new Error("database is locked");
        mock.store.set(`${key}::${scope}`, value);
      },
    };
    await post({ messagesPerMinute: 30, messagesPerHour: 500 }, {
      daemonStorage: flaky,
      rateLimiter: limiter,
      readJsonBody,
    } as unknown as RouteContext);

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(mock.store.get("rate_limit_messages_per_minute::global")).toBe("11");
    expect(mock.store.get("rate_limit_messages_per_hour::global")).toBe("22");
    expect(limiter.getConfig()).toMatchObject({ messagesPerMinute: 4, messagesPerHour: 40 });
  });

  it("a good POST still commits and takes effect (guard)", async () => {
    const limiter = new RateLimiter({ messagesPerMinute: 4, messagesPerHour: 40, tokensPerDay: 400 });
    await post({ messagesPerMinute: 30, messagesPerHour: 500 }, makeCtxWithLimiter(storage, limiter));
    expect(res.statusCode).toBe(200);
    expect(storage.getSettingsOverride("rate_limit_messages_per_minute")).toBe("30");
    expect(storage.getSettingsOverride("rate_limit_messages_per_hour")).toBe("500");
    expect(limiter.getConfig()).toMatchObject({ messagesPerMinute: 30, messagesPerHour: 500, tokensPerDay: 400 });
    // The GET a reload does now reports exactly that.
    expect(get(makeCtxWithLimiter(storage, limiter))).toEqual({
      messagesPerMinute: 30,
      messagesPerHour: 500,
      tokensPerDay: 400,
    });
  });
});
