import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleSettingsRoutes } from "./server-settings-routes.js";
import type { RouteContext } from "./server-types.js";

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

function createMockReq(): IncomingMessage {
  return {} as IncomingMessage;
}

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

/** Wait for the POST handler's readJsonBody().then(...) chain to settle */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
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

  /** Parse the JSON body written to the mock response */
  function responseJson(): Record<string, unknown> {
    return JSON.parse((res as MockRes).body) as Record<string, unknown>;
  }

  it("GET with empty storage returns null voice fields and global scope", () => {
    const handled = handleSettingsRoutes("/api/settings/voice", "GET", createMockReq(), res, createCtx(storage));
    expect(handled).toBe(true);
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

  it("POST persists portal voice fields under global scope", async () => {
    const ctx = createCtx(storage, { inputEnabled: false, outputEnabled: true, browserSttEnabled: true });
    const handled = handleSettingsRoutes("/api/settings/voice", "POST", createMockReq(), res, ctx);
    expect(handled).toBe(true);
    await flushAsync();

    expect(responseJson()).toEqual({ success: true });
    expect(storage.store.get("voice_input_enabled::global")).toBe("false");
    expect(storage.store.get("voice_output_enabled::global")).toBe("true");
    expect(storage.store.get("voice_browser_stt_enabled::global")).toBe("true");
  });

  it("GET after POST round-trips the portal voice fields", async () => {
    const postCtx = createCtx(storage, { inputEnabled: false, outputEnabled: true, browserSttEnabled: true });
    handleSettingsRoutes("/api/settings/voice", "POST", createMockReq(), createMockRes(), postCtx);
    await flushAsync();

    handleSettingsRoutes("/api/settings/voice", "GET", createMockReq(), res, createCtx(storage));
    expect(responseJson()).toMatchObject({
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
    expect(responseJson()).toMatchObject({
      inputEnabled: true,
      outputEnabled: false,
      browserSttEnabled: true,
      chatId: "abc",
    });

    // Plain GET (global scope) still returns nulls
    const globalRes = createMockRes();
    handleSettingsRoutes("/api/settings/voice", "GET", createMockReq(), globalRes, createCtx(storage));
    expect(JSON.parse((globalRes as MockRes).body)).toMatchObject({
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
    expect(responseJson()).toMatchObject({
      enabled: true,
      language: "tr",
      speed: 1.25,
    });
  });

  it("ignores non-boolean values for the portal voice fields", async () => {
    const ctx = createCtx(storage, { inputEnabled: "yes", outputEnabled: 1, browserSttEnabled: null });
    handleSettingsRoutes("/api/settings/voice", "POST", createMockReq(), res, ctx);
    await flushAsync();

    expect(responseJson()).toEqual({ success: true });
    expect(storage.store.has("voice_input_enabled::global")).toBe(false);
    expect(storage.store.has("voice_output_enabled::global")).toBe(false);
    expect(storage.store.has("voice_browser_stt_enabled::global")).toBe(false);
  });

  it("returns 405 for unsupported methods", () => {
    const handled = handleSettingsRoutes("/api/settings/voice", "PUT", createMockReq(), res, createCtx(storage));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(responseJson()).toEqual({ error: "Method not allowed" });
  });

  it("returns 503 when storage is unavailable", () => {
    const ctx = { daemonStorage: undefined, readJsonBody: vi.fn() } as unknown as RouteContext;
    const handled = handleSettingsRoutes("/api/settings/voice", "GET", createMockReq(), res, ctx);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
  });
});
