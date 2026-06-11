import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerResponse } from "node:http";
import { handleSettingsRoutes } from "./server-settings-routes.js";
import {
  createMockReq,
  createMockRes,
  flushAsync,
  responseJson,
  type MockRes,
} from "./test-support/mock-http.js";
import type { RouteContext } from "./server-types.js";

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
