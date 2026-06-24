import { describe, it, expect, vi } from "vitest";
import { handlePersonalityRoutes } from "./server-personality-routes.js";
import {
  createMockReq,
  createMockRes,
  createStreamReq,
  responseJson,
  type MockRes,
} from "./test-support/mock-http.js";
import type { RouteContext } from "./server-types.js";

vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  const stub = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { ...actual, getLogger: () => stub, getLoggerSafe: () => stub };
});

// =============================================================================
// HELPERS
// =============================================================================

function makeCtx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    readJsonBody: vi.fn().mockResolvedValue(null),
    getAutonomousDefaults: vi.fn(() => ({ enabled: false })),
    ...overrides,
  } as unknown as RouteContext;
}

function route(
  url: string,
  method: string,
  ctx?: RouteContext,
): { handled: boolean; res: MockRes & import("node:http").ServerResponse } {
  const res = createMockRes();
  const handled = handlePersonalityRoutes(url, method, createMockReq(), res, ctx ?? makeCtx());
  return { handled, res };
}

function makeSoulLoader(overrides: Record<string, unknown> = {}): RouteContext["soulLoader"] {
  return {
    getActiveProfile: vi.fn(() => "default"),
    getContent: vi.fn(() => "You are Strada Brain."),
    getProfiles: vi.fn(() => ["default", "concise"]),
    getChannelOverrides: vi.fn(() => ({})),
    saveProfile: vi.fn().mockResolvedValue(true),
    deleteProfile: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as RouteContext["soulLoader"];
}

// =============================================================================
// TESTS — fall-through
// =============================================================================

describe("handlePersonalityRoutes — fall-through", () => {
  it("returns false for an unrelated URL", () => {
    const { handled, res } = route("/api/unknown", "GET");
    expect(handled).toBe(false);
    expect(res.end).not.toHaveBeenCalled();
  });

  it("returns false for /api/vaults", () => {
    const { handled } = route("/api/vaults", "GET");
    expect(handled).toBe(false);
  });
});

// =============================================================================
// TESTS — GET /api/personality
// =============================================================================

describe("handlePersonalityRoutes — GET /api/personality", () => {
  it("returns { personality: null } when no soulLoader in ctx", () => {
    const { handled, res } = route("/api/personality", "GET");
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toEqual({ personality: null });
  });

  it("returns full personality shape when soulLoader is present", () => {
    const soulLoader = makeSoulLoader();
    const ctx = makeCtx({ soulLoader });
    const { handled, res } = route("/api/personality", "GET", ctx);
    expect(handled).toBe(true);
    const body = responseJson(res);
    expect(body.personality).toMatchObject({
      content: "You are Strada Brain.",
      activeProfile: "default",
      profiles: ["default", "concise"],
    });
  });

  it("overrides activeProfile from userProfileStore when chatId provided and persona set", () => {
    const soulLoader = makeSoulLoader({ getActiveProfile: vi.fn(() => "default") });
    const userProfileStore = {
      getProfile: vi.fn(() => ({ activePersona: "concise" })),
    };
    const ctx = makeCtx({
      soulLoader,
      userProfileStore: userProfileStore as unknown as RouteContext["userProfileStore"],
    });
    const { handled, res } = route("/api/personality?chatId=user123", "GET", ctx);
    expect(handled).toBe(true);
    const body = responseJson(res) as { personality: { activeProfile: string } };
    expect(body.personality.activeProfile).toBe("concise");
  });

  it("does not override activeProfile when persona is 'default'", () => {
    const soulLoader = makeSoulLoader({ getActiveProfile: vi.fn(() => "default") });
    const userProfileStore = {
      getProfile: vi.fn(() => ({ activePersona: "default" })),
    };
    const ctx = makeCtx({
      soulLoader,
      userProfileStore: userProfileStore as unknown as RouteContext["userProfileStore"],
    });
    const { handled, res } = route("/api/personality?chatId=user123", "GET", ctx);
    expect(handled).toBe(true);
    const body = responseJson(res) as { personality: { activeProfile: string } };
    expect(body.personality.activeProfile).toBe("default");
  });
});

// =============================================================================
// TESTS — POST /api/personality/profiles
// =============================================================================

describe("handlePersonalityRoutes — POST /api/personality/profiles", () => {
  it("returns 501 when no soulLoader in ctx", async () => {
    const res = createMockRes();
    handlePersonalityRoutes("/api/personality/profiles", "POST", createStreamReq("{}"), res, makeCtx());
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(501);
  });

  it("returns 400 for an invalid profile name (special chars)", async () => {
    const ctx = makeCtx({
      soulLoader: makeSoulLoader(),
      readJsonBody: vi.fn().mockResolvedValue({ name: "my profile!", content: "..." }),
    });
    const res = createMockRes();
    handlePersonalityRoutes("/api/personality/profiles", "POST", createStreamReq("{}"), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(400);
    expect((responseJson(res) as { error: string }).error).toContain("Invalid profile name");
  });

  it("returns 400 for an empty profile name", async () => {
    const ctx = makeCtx({
      soulLoader: makeSoulLoader(),
      readJsonBody: vi.fn().mockResolvedValue({ name: "", content: "hello" }),
    });
    const res = createMockRes();
    handlePersonalityRoutes("/api/personality/profiles", "POST", createStreamReq("{}"), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for system profiles (e.g. 'default')", async () => {
    const ctx = makeCtx({
      soulLoader: makeSoulLoader(),
      readJsonBody: vi.fn().mockResolvedValue({ name: "default", content: "override" }),
    });
    const res = createMockRes();
    handlePersonalityRoutes("/api/personality/profiles", "POST", createStreamReq("{}"), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(400);
    expect((responseJson(res) as { error: string }).error).toContain("system profile");
  });

  it("saves a valid profile and returns 200 with updated list", async () => {
    const soulLoader = makeSoulLoader();
    const ctx = makeCtx({
      soulLoader,
      readJsonBody: vi.fn().mockResolvedValue({ name: "custom-tone", content: "Be concise." }),
    });
    const res = createMockRes();
    handlePersonalityRoutes("/api/personality/profiles", "POST", createStreamReq("{}"), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(200);
    const body = responseJson(res);
    expect(body.success).toBe(true);
    expect(body.profile).toBe("custom-tone");
  });
});

// =============================================================================
// TESTS — DELETE /api/personality/profiles/:name
// =============================================================================

describe("handlePersonalityRoutes — DELETE /api/personality/profiles/:name", () => {
  it("returns 501 when no soulLoader in ctx", async () => {
    const res = createMockRes();
    handlePersonalityRoutes("/api/personality/profiles/myprofile", "DELETE", createMockReq(), res, makeCtx());
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(501);
  });

  it("returns 400 for a system profile like 'default'", async () => {
    const ctx = makeCtx({ soulLoader: makeSoulLoader() });
    const res = createMockRes();
    handlePersonalityRoutes("/api/personality/profiles/default", "DELETE", createMockReq(), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(400);
    expect((responseJson(res) as { error: string }).error).toContain("system profile");
  });

  it("deletes a custom profile and returns { success: true }", async () => {
    const ctx = makeCtx({ soulLoader: makeSoulLoader() });
    const res = createMockRes();
    handlePersonalityRoutes("/api/personality/profiles/custom-tone", "DELETE", createMockReq(), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(200);
    expect((responseJson(res) as { success: boolean }).success).toBe(true);
  });

  it("returns 404 when deleteProfile returns false", async () => {
    const soulLoader = makeSoulLoader({ deleteProfile: vi.fn().mockResolvedValue(false) });
    const ctx = makeCtx({ soulLoader });
    const res = createMockRes();
    handlePersonalityRoutes("/api/personality/profiles/nonexistent", "DELETE", createMockReq(), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(404);
  });
});

// =============================================================================
// TESTS — POST /api/personality/switch
// =============================================================================

describe("handlePersonalityRoutes — POST /api/personality/switch", () => {
  it("returns 501 when no soulLoader", async () => {
    const ctx = makeCtx({ readJsonBody: vi.fn().mockResolvedValue({ profile: "concise" }) });
    const res = createMockRes();
    handlePersonalityRoutes("/api/personality/switch", "POST", createMockReq(), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(501);
  });

  it("returns 400 for an invalid profile name", async () => {
    const ctx = makeCtx({
      soulLoader: makeSoulLoader(),
      readJsonBody: vi.fn().mockResolvedValue({ profile: "my bad name!" }),
    });
    const res = createMockRes();
    handlePersonalityRoutes("/api/personality/switch", "POST", createMockReq(), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when profile is not in the available list", async () => {
    const ctx = makeCtx({
      soulLoader: makeSoulLoader({ getProfiles: vi.fn(() => ["default"]) }),
      readJsonBody: vi.fn().mockResolvedValue({ profile: "concise" }),
    });
    const res = createMockRes();
    handlePersonalityRoutes("/api/personality/switch", "POST", createMockReq(), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(400);
    expect((responseJson(res) as { error: string }).error).toContain("not found");
  });

  it("switches profile, persists per-user persona, and returns { success: true, activeProfile }", async () => {
    const setActivePersona = vi.fn();
    const ctx = makeCtx({
      soulLoader: makeSoulLoader({ getProfiles: vi.fn(() => ["default", "concise"]) }),
      userProfileStore: { setActivePersona } as unknown as RouteContext["userProfileStore"],
      readJsonBody: vi.fn().mockResolvedValue({ profile: "concise", chatId: "chat-1" }),
    });
    const res = createMockRes();
    handlePersonalityRoutes("/api/personality/switch", "POST", createMockReq(), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toMatchObject({ success: true, activeProfile: "concise" });
    // BUG #2 regression: a valid identity must actually persist the persona.
    expect(setActivePersona).toHaveBeenCalledWith("chat-1", "concise");
  });

  it("resolves identity via userId when chatId is absent and persists under it", async () => {
    const setActivePersona = vi.fn();
    const ctx = makeCtx({
      soulLoader: makeSoulLoader({ getProfiles: vi.fn(() => ["default", "concise"]) }),
      userProfileStore: { setActivePersona } as unknown as RouteContext["userProfileStore"],
      readJsonBody: vi.fn().mockResolvedValue({ profile: "concise", userId: "user-7" }),
    });
    const res = createMockRes();
    handlePersonalityRoutes("/api/personality/switch", "POST", createMockReq(), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(200);
    expect(setActivePersona).toHaveBeenCalledWith("user-7", "concise");
  });

  it("returns 400 (not a silent success) when no persistable identity resolves", async () => {
    const setActivePersona = vi.fn();
    const ctx = makeCtx({
      soulLoader: makeSoulLoader({ getProfiles: vi.fn(() => ["default", "concise"]) }),
      userProfileStore: { setActivePersona } as unknown as RouteContext["userProfileStore"],
      // No chatId / userId / conversationId → setActivePersona would be a no-op.
      readJsonBody: vi.fn().mockResolvedValue({ profile: "concise" }),
    });
    const res = createMockRes();
    handlePersonalityRoutes("/api/personality/switch", "POST", createMockReq(), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(400);
    const body = responseJson(res) as { success?: boolean; error: string };
    expect(body.success).not.toBe(true);
    expect(body.error).toContain("persistable identity");
    expect(setActivePersona).not.toHaveBeenCalled();
  });

  it("returns 400 for an oversized identity value", async () => {
    const longId = "x".repeat(200);
    const ctx = makeCtx({
      soulLoader: makeSoulLoader({ getProfiles: vi.fn(() => ["default", "concise"]) }),
      userProfileStore: { setActivePersona: vi.fn() } as unknown as RouteContext["userProfileStore"],
      readJsonBody: vi.fn().mockResolvedValue({ profile: "concise", chatId: longId }),
    });
    const res = createMockRes();
    handlePersonalityRoutes("/api/personality/switch", "POST", createMockReq(), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(400);
    expect((responseJson(res) as { error: string }).error).toContain("too long");
  });
});

// =============================================================================
// TESTS — GET /api/user/autonomous
// =============================================================================

describe("handlePersonalityRoutes — GET /api/user/autonomous", () => {
  it("returns 501 when no userProfileStore", () => {
    const { handled, res } = route("/api/user/autonomous?chatId=c1", "GET");
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(501);
  });

  it("returns 400 when chatId query param is missing", () => {
    const ctx = makeCtx({ userProfileStore: {} as RouteContext["userProfileStore"] });
    const { handled, res } = route("/api/user/autonomous", "GET", ctx);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    expect((responseJson(res) as { error: string }).error).toContain("chatId");
  });

  it("returns 400 for an oversized chatId (> DASHBOARD_IDENTITY_MAX_LENGTH)", () => {
    const longId = "a".repeat(1000);
    const ctx = makeCtx({ userProfileStore: {} as RouteContext["userProfileStore"] });
    const { handled, res } = route(`/api/user/autonomous?chatId=${longId}`, "GET", ctx);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    expect((responseJson(res) as { error: string }).error).toContain("too long");
  });

  it("returns autonomous mode result for a valid chatId", async () => {
    const store = {
      getProfile: vi.fn(() => null),
      setAutonomousMode: vi.fn().mockResolvedValue(undefined),
      isAutonomousMode: vi.fn().mockResolvedValue({ enabled: false }),
    };
    const ctx = makeCtx({
      userProfileStore: store as unknown as RouteContext["userProfileStore"],
      getAutonomousDefaults: vi.fn(() => ({ enabled: false })),
    });
    const res = createMockRes();
    handlePersonalityRoutes("/api/user/autonomous?chatId=chat-1", "GET", createMockReq(), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(200);
    // Shape: result of resolveAutonomousModeWithDefault — at least has `enabled`
    const body = responseJson(res);
    expect(typeof body.enabled).toBe("boolean");
  });
});

// =============================================================================
// TESTS — POST /api/user/autonomous
// =============================================================================

describe("handlePersonalityRoutes — POST /api/user/autonomous", () => {
  it("returns 501 when no userProfileStore", async () => {
    const ctx = makeCtx({ readJsonBody: vi.fn().mockResolvedValue({ enabled: true }) });
    const res = createMockRes();
    handlePersonalityRoutes("/api/user/autonomous?chatId=c1", "POST", createMockReq(), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(501);
  });

  it("returns 400 when chatId is missing", async () => {
    const store = { setAutonomousMode: vi.fn().mockResolvedValue(undefined) };
    const ctx = makeCtx({
      userProfileStore: store as unknown as RouteContext["userProfileStore"],
      readJsonBody: vi.fn().mockResolvedValue({ enabled: true }),
    });
    const res = createMockRes();
    handlePersonalityRoutes("/api/user/autonomous", "POST", createMockReq(), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(400);
    expect((responseJson(res) as { error: string }).error).toContain("chatId");
  });

  it("returns 400 when `enabled` field is missing from body", async () => {
    const store = { setAutonomousMode: vi.fn().mockResolvedValue(undefined) };
    const ctx = makeCtx({
      userProfileStore: store as unknown as RouteContext["userProfileStore"],
      readJsonBody: vi.fn().mockResolvedValue({ hours: 2 }),
    });
    const res = createMockRes();
    handlePersonalityRoutes("/api/user/autonomous?chatId=c1", "POST", createMockReq(), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(400);
    expect((responseJson(res) as { error: string }).error).toContain("enabled");
  });

  it("returns 400 when hours is out of range", async () => {
    const store = { setAutonomousMode: vi.fn().mockResolvedValue(undefined) };
    const ctx = makeCtx({
      userProfileStore: store as unknown as RouteContext["userProfileStore"],
      readJsonBody: vi.fn().mockResolvedValue({ enabled: true, durationHours: 999 }),
    });
    const res = createMockRes();
    handlePersonalityRoutes("/api/user/autonomous?chatId=c1", "POST", createMockReq(), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(400);
    expect((responseJson(res) as { error: string }).error).toContain("hours");
  });

  it("sets autonomous mode and returns { success: true, enabled, expiresAt }", async () => {
    const store = { setAutonomousMode: vi.fn().mockResolvedValue(undefined) };
    const ctx = makeCtx({
      userProfileStore: store as unknown as RouteContext["userProfileStore"],
      readJsonBody: vi.fn().mockResolvedValue({ enabled: true, durationHours: 4 }),
    });
    const res = createMockRes();
    handlePersonalityRoutes("/api/user/autonomous?chatId=c1", "POST", createMockReq(), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(200);
    const body = responseJson(res);
    expect(body.success).toBe(true);
    expect(body.enabled).toBe(true);
    expect(typeof body.expiresAt).toBe("number");
  });

  it("sets autonomous mode without expiry when hours not provided", async () => {
    const store = { setAutonomousMode: vi.fn().mockResolvedValue(undefined) };
    const ctx = makeCtx({
      userProfileStore: store as unknown as RouteContext["userProfileStore"],
      readJsonBody: vi.fn().mockResolvedValue({ enabled: false }),
    });
    const res = createMockRes();
    handlePersonalityRoutes("/api/user/autonomous?chatId=c1", "POST", createMockReq(), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(200);
    const body = responseJson(res);
    expect(body.expiresAt).toBeNull();
  });
});
