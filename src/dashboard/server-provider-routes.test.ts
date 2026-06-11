import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleProviderRoutes } from "./server-provider-routes.js";
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

function responseJson(res: MockRes & ServerResponse): Record<string, unknown> {
  return JSON.parse((res as MockRes).body) as Record<string, unknown>;
}

/** Wait for handlers driven by readJsonBody().then(...) chains to settle */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

// =============================================================================
// FAKES
// =============================================================================

interface FakeProviderManager {
  listAvailable: ReturnType<typeof vi.fn>;
  getActiveInfo: ReturnType<typeof vi.fn>;
  setPreference: ReturnType<typeof vi.fn>;
}

function fakeProviderManager(): FakeProviderManager {
  return {
    listAvailable: vi.fn(() => [{ name: "openai", configured: true }]),
    getActiveInfo: vi.fn(() => ({ provider: "openai", model: "gpt-4o" })),
    setPreference: vi.fn(async () => {}),
  };
}

function fakeProviderRouter(): { setPreset: ReturnType<typeof vi.fn>; getPreset: ReturnType<typeof vi.fn> } {
  return {
    setPreset: vi.fn(),
    getPreset: vi.fn(() => "balanced"),
  };
}

function makeCtx(overrides: Record<string, unknown> = {}, body?: unknown): RouteContext {
  return {
    lastModelRefreshMs: 0,
    setLastModelRefreshMs: vi.fn(),
    readJsonBody: vi.fn(async () => body ?? null),
    ...overrides,
  } as unknown as RouteContext;
}

// =============================================================================
// TESTS
// =============================================================================

describe("handleProviderRoutes — fall-through", () => {
  it("returns false for an unmatched URL", () => {
    const res = createMockRes();
    const handled = handleProviderRoutes("/api/unknown", "GET", createMockReq(), res, makeCtx());
    expect(handled).toBe(false);
    expect(res.end).not.toHaveBeenCalled();
  });
});

describe("handleProviderRoutes — GET /api/providers/available", () => {
  it("returns 501 without a provider manager", () => {
    const res = createMockRes();
    const handled = handleProviderRoutes("/api/providers/available", "GET", createMockReq(), res, makeCtx());
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(501);
    expect(responseJson(res)).toEqual({ error: "Provider manager not available" });
  });

  it("returns the available providers", () => {
    const manager = fakeProviderManager();
    const res = createMockRes();
    const handled = handleProviderRoutes(
      "/api/providers/available", "GET", createMockReq(), res,
      makeCtx({ providerManager: manager }),
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toEqual({ providers: [{ name: "openai", configured: true }] });
  });
});

describe("handleProviderRoutes — GET /api/providers/active", () => {
  function getActive(url: string): MockRes & ServerResponse {
    const res = createMockRes();
    const handled = handleProviderRoutes(
      url, "GET", createMockReq(), res,
      makeCtx({ providerManager: fakeProviderManager() }),
    );
    expect(handled).toBe(true);
    return res;
  }

  it("returns 400 when chatId is missing", () => {
    const res = getActive("/api/providers/active");
    expect(res.statusCode).toBe(400);
    expect(String(responseJson(res).error)).toContain("chatId");
  });

  it("returns 400 when chatId exceeds 128 chars", () => {
    const res = getActive(`/api/providers/active?chatId=${"a".repeat(129)}`);
    expect(res.statusCode).toBe(400);
    expect(String(responseJson(res).error)).toContain("Identity values too long");
  });

  it("returns the active provider and execution pool", () => {
    const manager = fakeProviderManager();
    const res = createMockRes();
    handleProviderRoutes(
      "/api/providers/active?chatId=chat1", "GET", createMockReq(), res,
      makeCtx({ providerManager: manager }),
    );
    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toEqual({
      active: { provider: "openai", model: "gpt-4o" },
      executionPool: null,
    });
    expect(manager.getActiveInfo).toHaveBeenCalledWith("chat1");
  });
});

describe("handleProviderRoutes — POST /api/providers/switch", () => {
  function postSwitch(body: unknown, manager = fakeProviderManager()): {
    res: MockRes & ServerResponse;
    manager: FakeProviderManager;
  } {
    const res = createMockRes();
    const handled = handleProviderRoutes(
      "/api/providers/switch", "POST", createMockReq(), res,
      makeCtx({ providerManager: manager }, body),
    );
    expect(handled).toBe(true);
    return { res, manager };
  }

  it("returns 400 when chatId/provider are missing", async () => {
    const { res } = postSwitch({});
    await flushAsync();
    expect(res.statusCode).toBe(400);
    expect(String(responseJson(res).error)).toContain("Missing required fields");
  });

  it("returns 400 for an invalid model name", async () => {
    const { res } = postSwitch({ chatId: "c", provider: "openai", model: "bad model!" });
    await flushAsync();
    expect(res.statusCode).toBe(400);
    expect(responseJson(res)).toEqual({ error: "Invalid model name" });
  });

  it("returns 400 for an unknown provider", async () => {
    const { res } = postSwitch({ chatId: "c", provider: "nope" });
    await flushAsync();
    expect(res.statusCode).toBe(400);
    expect(String(responseJson(res).error)).toContain('Provider "nope" is not available');
  });

  it("switches provider with preference-bias by default", async () => {
    const { res, manager } = postSwitch({ chatId: "c", provider: "openai", model: "gpt-4o" });
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toEqual({
      success: true,
      provider: "openai",
      model: "gpt-4o",
      selectionMode: "strada-preference-bias",
    });
    expect(manager.setPreference).toHaveBeenCalledWith("c", "openai", "gpt-4o", "strada-preference-bias");
  });

  it("hardPin: true selects strada-hard-pin mode", async () => {
    const { res } = postSwitch({ chatId: "c", provider: "openai", hardPin: true });
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(responseJson(res)).toMatchObject({ selectionMode: "strada-hard-pin" });
  });

  it("writes nothing when readJsonBody resolves null (error already sent)", async () => {
    const { res } = postSwitch(null);
    await flushAsync();
    expect(res.end).not.toHaveBeenCalled();
  });
});

describe("handleProviderRoutes — POST /api/models/refresh", () => {
  it("returns 429 with Retry-After within the 60s window", () => {
    const res = createMockRes();
    const handled = handleProviderRoutes(
      "/api/models/refresh", "POST", createMockReq(), res,
      makeCtx({
        providerManager: fakeProviderManager(),
        lastModelRefreshMs: Date.now(),
      }),
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(429);
    expect(Number((res as MockRes).headers["Retry-After"])).toBeGreaterThan(0);
    expect(String(responseJson(res).error)).toContain("Rate limit");
  });

  it("returns 501 when the manager has no refreshCatalog", () => {
    const setLastModelRefreshMs = vi.fn();
    const res = createMockRes();
    handleProviderRoutes(
      "/api/models/refresh", "POST", createMockReq(), res,
      makeCtx({
        providerManager: fakeProviderManager(),
        lastModelRefreshMs: 0,
        setLastModelRefreshMs,
      }),
    );
    expect(res.statusCode).toBe(501);
    expect(responseJson(res)).toEqual({ error: "Provider catalog refresh not available" });
    expect(setLastModelRefreshMs).toHaveBeenCalled();
  });
});

describe("handleProviderRoutes — POST /api/routing/preset", () => {
  it("returns 501 without a provider router", () => {
    const res = createMockRes();
    const handled = handleProviderRoutes(
      "/api/routing/preset", "POST", createMockReq(), res, makeCtx({}, { preset: "budget" }),
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(501);
    expect(responseJson(res)).toEqual({ error: "Provider router not available" });
  });

  it("returns 400 for an invalid preset", async () => {
    const res = createMockRes();
    handleProviderRoutes(
      "/api/routing/preset", "POST", createMockReq(), res,
      makeCtx({ providerRouter: fakeProviderRouter() }, { preset: "turbo" }),
    );
    await flushAsync();
    expect(res.statusCode).toBe(400);
    expect(String(responseJson(res).error)).toContain("Invalid preset");
  });

  it("applies a valid preset", async () => {
    const router = fakeProviderRouter();
    const res = createMockRes();
    handleProviderRoutes(
      "/api/routing/preset", "POST", createMockReq(), res,
      makeCtx({ providerRouter: router }, { preset: "budget" }),
    );
    await flushAsync();
    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toEqual({ success: true, preset: "budget" });
    expect(router.setPreset).toHaveBeenCalledWith("budget");
  });
});
