import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import {
  handleVaultRoutes,
  registerVaultRoutes,
  buildVaultRetrievalStatsSnapshot,
  wireVaultUpdatesToWs,
  resetVaultSearchRateLimiterForTests,
  type VaultFactory,
  type RouteApp,
  type WsBroadcaster,
} from "./server-vault-routes.js";
import {
  createMockReq,
  createMockRes,
  createStreamReq,
  createStreamReqFrom,
  responseJson,
  type MockRes,
} from "./test-support/mock-http.js";
import { createFakeVault, createTempDirTracker } from "../test-helpers.js";
import { VaultRegistry } from "../vault/vault-registry.js";
import { VaultQueryError } from "../vault/obsidian-vault.js";
import type { IVault } from "../vault/vault.interface.js";
import type { RouteContext } from "./server-types.js";

vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  const stub = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { ...actual, getLogger: () => stub, getLoggerSafe: () => stub };
});

// The search endpoint is rate-limited per source IP (plan 004); reset between
// tests so unrelated search cases never trip a shared bucket.
beforeEach(() => {
  resetVaultSearchRateLimiterForTests();
});

// =============================================================================
// HELPERS
// =============================================================================

function makeCtx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    lastModelRefreshMs: 0,
    setLastModelRefreshMs: vi.fn(),
    readJsonBody: vi.fn(async () => null),
    ...overrides,
  } as unknown as RouteContext;
}

/** Fake vault whose onUpdate listeners can be triggered from the test. */
function fakeVaultWithUpdates(id: string): {
  vault: IVault;
  emit: (p: { vaultId: string; changedPaths: string[] }) => void;
  off: ReturnType<typeof vi.fn>;
} {
  const listeners: Array<(p: { vaultId: string; changedPaths: string[] }) => void> = [];
  const off = vi.fn();
  const vault = createFakeVault({
    id,
    onUpdate: vi.fn((listener: (p: { vaultId: string; changedPaths: string[] }) => void) => {
      listeners.push(listener);
      return off;
    }),
  });
  return {
    vault,
    emit: (p) => { for (const listener of listeners) listener(p); },
    off,
  };
}

const tmp = createTempDirTracker("vault-routes-test-");
afterAll(() => tmp.cleanup());

// =============================================================================
// TESTS — handleVaultRoutes (production raw-http path)
// =============================================================================

describe("handleVaultRoutes — fall-through & guards", () => {
  it("returns false for non-vault URLs", () => {
    const res = createMockRes();
    const handled = handleVaultRoutes(
      "/api/metrics", "GET", createMockReq(), res, makeCtx({ vaultRegistry: new VaultRegistry() }),
    );
    expect(handled).toBe(false);
    expect(res.end).not.toHaveBeenCalled();
  });

  it("returns 503 when the vault registry is not enabled", () => {
    const res = createMockRes();
    const handled = handleVaultRoutes("/api/vaults", "GET", createMockReq(), res, makeCtx());
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(responseJson(res)).toEqual({ error: "vault subsystem not enabled" });
  });

  it("returns false for an unknown vault sub-route", () => {
    const registry = new VaultRegistry();
    const res = createMockRes();
    const handled = handleVaultRoutes(
      "/api/vaults-unknown-thing", "GET", createMockReq(), res, makeCtx({ vaultRegistry: registry }),
    );
    expect(handled).toBe(false);
  });
});

describe("handleVaultRoutes — GET /api/vaults", () => {
  it("lists vaults without leaking rootPath", () => {
    const registry = new VaultRegistry();
    registry.register(createFakeVault({ rootPath: "/Users/secret/project" }));
    const res = createMockRes();
    const handled = handleVaultRoutes(
      "/api/vaults", "GET", createMockReq(), res, makeCtx({ vaultRegistry: registry }),
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toEqual({
      items: [{ id: "unity:abc12345", kind: "unity-project" }],
    });
    expect((res as MockRes).body).not.toContain("/Users/secret");
  });
});

describe("handleVaultRoutes — POST /api/vaults", () => {
  let registry: VaultRegistry;
  let factory: VaultFactory;
  let created: Array<{ id: string; rootPath: string; kind: "unity" | "generic" }>;

  beforeEach(() => {
    registry = new VaultRegistry();
    created = [];
    factory = {
      create: vi.fn(async (spec: { id: string; rootPath: string; kind: "unity" | "generic" }) => {
        created.push(spec);
        return createFakeVault({ id: spec.id });
      }),
    };
  });

  function postVault(body: unknown, withFactory = true): MockRes & ServerResponse {
    const res = createMockRes();
    const ctx = makeCtx({ vaultRegistry: registry, ...(withFactory ? { vaultFactory: factory } : {}) });
    const handled = handleVaultRoutes(
      "/api/vaults", "POST", createStreamReq(JSON.stringify(body)), res, ctx,
    );
    expect(handled).toBe(true);
    return res;
  }

  it("returns 503 when no VaultFactory is installed", () => {
    const res = postVault({ name: "X", rootPath: "/tmp" }, false);
    expect(res.statusCode).toBe(503);
    expect(String(responseJson(res).error)).toContain("VaultFactory not installed");
  });

  it.each([
    ["slash in name", { name: "a/b", rootPath: "/tmp" }, "invalid name"],
    ["empty name", { name: "", rootPath: "/tmp" }, "invalid name"],
    ["name longer than 64 chars", { name: "a".repeat(65), rootPath: "/tmp" }, "invalid name"],
    ["relative rootPath", { name: "ok", rootPath: "relative/path" }, "rootPath must be absolute"],
    ["NUL byte in rootPath", { name: "ok", rootPath: "/tmp/x\u0000y" }, "invalid rootPath"],
    ["unknown kind", { name: "ok", rootPath: "/tmp", kind: "weird" }, "invalid kind"],
  ])("rejects %s with 400", async (_label, body, expectedError) => {
    const res = postVault(body);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(400);
    expect(responseJson(res)).toEqual({ error: expectedError });
  });

  it("rejects a nonexistent absolute directory with 400", async () => {
    const res = postVault({ name: "ok", rootPath: join(tmpdir(), "does-not-exist-xyz-007") });
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(400);
    expect(responseJson(res)).toEqual({ error: "path does not exist" });
  });

  it("registers a vault with 201 then rejects a duplicate with 409", async () => {
    const dir = tmp.makeDir();
    const res = postVault({ name: "My Vault", rootPath: dir, kind: "generic" });
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(201);
    const created0 = created[0]!;
    expect(responseJson(res)).toEqual({
      id: created0.id,
      name: "My Vault",
      kind: "unity-project",
      status: "indexing",
      symbolCount: 0,
    });
    expect(created0.kind).toBe("generic");
    const vault = registry.get(created0.id);
    expect(vault).toBeDefined();
    // init is fire-and-forget after the 201 response.
    await vi.waitFor(() => expect(vault!.init).toHaveBeenCalled());

    const res2 = postVault({ name: "My Vault", rootPath: dir, kind: "generic" });
    await vi.waitFor(() => expect(res2.end).toHaveBeenCalled());
    expect(res2.statusCode).toBe(409);
    expect(responseJson(res2)).toEqual({ error: "vault already registered" });
  });
});

describe("handleVaultRoutes — DELETE /api/vaults/:id", () => {
  it("returns 404 for an unknown vault id", () => {
    const registry = new VaultRegistry();
    const res = createMockRes();
    handleVaultRoutes("/api/vaults/nope", "DELETE", createMockReq(), res, makeCtx({ vaultRegistry: registry }));
    expect(res.statusCode).toBe(404);
    expect(responseJson(res)).toEqual({ error: "vault not found" });
  });

  it("unregisters and disposes the vault", () => {
    const registry = new VaultRegistry();
    const vault = createFakeVault();
    registry.register(vault);
    const res = createMockRes();
    handleVaultRoutes(
      "/api/vaults/unity:abc12345", "DELETE", createMockReq(), res, makeCtx({ vaultRegistry: registry }),
    );
    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toEqual({ ok: true, id: "unity:abc12345" });
    expect(registry.get("unity:abc12345")).toBeUndefined();
    expect(vault.dispose).toHaveBeenCalled();
  });
});

describe("handleVaultRoutes — GET /api/vaults/:id/file", () => {
  let registry: VaultRegistry;
  let vault: IVault;

  beforeEach(() => {
    registry = new VaultRegistry();
    vault = createFakeVault({ id: "v1" });
    registry.register(vault);
  });

  function getFile(rawUrl: string): MockRes & ServerResponse {
    const res = createMockRes();
    const handled = handleVaultRoutes(rawUrl, "GET", createMockReq(), res, makeCtx({ vaultRegistry: registry }));
    expect(handled).toBe(true);
    return res;
  }

  it.each([
    ["decoded parent traversal", "/api/vaults/v1/file?path=..%2Fx"],
    ["absolute path", "/api/vaults/v1/file?path=%2Fabs"],
    ["double-encoded dots surviving decode", "/api/vaults/v1/file?path=a%252e%252eb"],
    ["missing path param", "/api/vaults/v1/file"],
    ["path longer than 1024 chars", `/api/vaults/v1/file?path=${"a".repeat(1025)}`],
    // %2500 decodes once to a literal "%00" in the query value.
    ["URL-encoded null byte", "/api/vaults/v1/file?path=%2500evil.md"],
  ])("rejects %s with 400 invalid path", (_label, rawUrl) => {
    const res = getFile(rawUrl);
    expect(res.statusCode).toBe(400);
    expect(responseJson(res)).toEqual({ error: "invalid path" });
    expect(vault.readFile).not.toHaveBeenCalled();
  });

  it("maps a readFile rejection to 400 invalid path", async () => {
    (vault.readFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    const res = getFile("/api/vaults/v1/file?path=ok.md");
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(400);
    expect(responseJson(res)).toEqual({ error: "invalid path" });
  });

  it("returns the file body on the happy path", async () => {
    const res = getFile("/api/vaults/v1/file?path=notes.md");
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toEqual({ body: "body" });
    expect(vault.readFile).toHaveBeenCalledWith("notes.md");
  });
});

describe("handleVaultRoutes — POST /api/vaults/:id/search", () => {
  let registry: VaultRegistry;
  let vault: IVault;

  beforeEach(() => {
    registry = new VaultRegistry();
    vault = createFakeVault({ id: "v1" });
    registry.register(vault);
  });

  function postSearch(body: unknown): MockRes & ServerResponse {
    const res = createMockRes();
    const handled = handleVaultRoutes(
      "/api/vaults/v1/search", "POST", createStreamReq(JSON.stringify(body)), res,
      makeCtx({ vaultRegistry: registry }),
    );
    expect(handled).toBe(true);
    return res;
  }

  it("rejects a non-string text with 400", async () => {
    const res = postSearch({ text: 42 });
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(400);
    expect(responseJson(res)).toEqual({ error: "invalid text" });
    expect(vault.query).not.toHaveBeenCalled();
  });

  it("surfaces a VaultQueryError as 400 with its message", async () => {
    (vault.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new VaultQueryError("Vault query is empty after sanitization", "empty_query"),
    );
    const res = postSearch({ text: "***" });
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(400);
    expect(responseJson(res)).toEqual({ error: "Vault query is empty after sanitization" });
  });

  it("returns the query result on the happy path with default topK", async () => {
    const res = postSearch({ text: "hello world" });
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toEqual({ hits: [], budgetUsed: 0, truncated: false });
    expect(vault.query).toHaveBeenCalledWith(expect.objectContaining({ text: "hello world", topK: 20 }));
  });
});

describe("handleVaultRoutes — POST /api/vaults/:id/sync (response sanitization)", () => {
  function postSync(syncResult: unknown): { res: MockRes & ServerResponse; vault: IVault } {
    const registry = new VaultRegistry();
    const vault = createFakeVault({
      id: "v1",
      sync: vi.fn(async () => syncResult as { changed: number; durationMs: number }),
    });
    registry.register(vault);
    const res = createMockRes();
    handleVaultRoutes(
      "/api/vaults/v1/sync", "POST", createMockReq(), res, makeCtx({ vaultRegistry: registry }),
    );
    return { res, vault };
  }

  it("replaces the raw canvas error and drops unknown fields", async () => {
    const { res } = postSync({
      changed: 1,
      durationMs: 5,
      canvas: { ok: false, error: "/Users/secret/project failed" },
      internalPath: "/Users/secret/leak",
    });
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toEqual({
      changed: 1,
      durationMs: 5,
      canvas: { ok: false, error: "canvas regeneration failed" },
    });
    expect((res as MockRes).body).not.toContain("/Users/secret");
  });

  it("passes a successful canvas through as { ok: true }", async () => {
    const { res } = postSync({ changed: 2, durationMs: 7, canvas: { ok: true, detail: "extra" } });
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(responseJson(res)).toEqual({ changed: 2, durationMs: 7, canvas: { ok: true } });
  });

  it("omits canvas entirely when sync reports none", async () => {
    const { res } = postSync({ changed: 0, durationMs: 1 });
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(responseJson(res)).toEqual({ changed: 0, durationMs: 1 });
  });
});

// =============================================================================
// TESTS — buildVaultRetrievalStatsSnapshot (pure)
// =============================================================================

describe("buildVaultRetrievalStatsSnapshot", () => {
  it("returns 0 hit rate for a zero denominator", () => {
    const snap = buildVaultRetrievalStatsSnapshot({ hits: 0, misses: 0, stale: 0 });
    expect(snap.fileRead.hitRatePct).toBe(0);
  });

  it("computes the hit rate percentage", () => {
    const snap = buildVaultRetrievalStatsSnapshot({ hits: 3, misses: 1, stale: 0 });
    expect(snap.fileRead).toEqual({ hits: 3, misses: 1, stale: 0, hitRatePct: 75 });
  });

  it("rounds the hit rate to two decimals", () => {
    const snap = buildVaultRetrievalStatsSnapshot({ hits: 1, misses: 2, stale: 0 });
    expect(snap.fileRead.hitRatePct).toBe(33.33);
  });

  it("reflects the injected clock in the timestamp", () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const snap = buildVaultRetrievalStatsSnapshot({ hits: 0, misses: 0, stale: 0 }, now);
    expect(snap.timestamp).toBe("2026-01-02T03:04:05.000Z");
  });

  it("backs GET /api/vaults/stats", () => {
    const registry = new VaultRegistry();
    const res = createMockRes();
    const handled = handleVaultRoutes(
      "/api/vaults/stats", "GET", createMockReq(), res, makeCtx({ vaultRegistry: registry }),
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = responseJson(res) as { fileRead: Record<string, number>; timestamp: string };
    expect(body.fileRead).toMatchObject({ hitRatePct: expect.any(Number) as number });
    expect(typeof body.timestamp).toBe("string");
  });
});

// =============================================================================
// TESTS — wireVaultUpdatesToWs
// =============================================================================

describe("wireVaultUpdatesToWs", () => {
  it("broadcasts vault:update messages for registered vaults", () => {
    const registry = new VaultRegistry();
    const { vault, emit } = fakeVaultWithUpdates("v1");
    registry.register(vault);
    const messages: string[] = [];
    const wss: WsBroadcaster = { broadcast: (msg) => { messages.push(msg); } };

    wireVaultUpdatesToWs(registry, wss);
    emit({ vaultId: "v1", changedPaths: ["a.md"] });

    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!)).toEqual({
      type: "vault:update",
      payload: { vaultId: "v1", changedPaths: ["a.md"] },
    });
  });

  it("swallows broadcaster throws", () => {
    const registry = new VaultRegistry();
    const { vault, emit } = fakeVaultWithUpdates("v1");
    registry.register(vault);
    const wss: WsBroadcaster = { broadcast: () => { throw new Error("client gone"); } };

    wireVaultUpdatesToWs(registry, wss);
    expect(() => emit({ vaultId: "v1", changedPaths: [] })).not.toThrow();
  });

  it("attaches to vaults registered after wiring", () => {
    const registry = new VaultRegistry();
    const messages: string[] = [];
    const wss: WsBroadcaster = { broadcast: (msg) => { messages.push(msg); } };

    wireVaultUpdatesToWs(registry, wss);
    const { vault, emit } = fakeVaultWithUpdates("late");
    registry.register(vault);
    emit({ vaultId: "late", changedPaths: ["x.cs"] });

    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!)).toMatchObject({ type: "vault:update" });
  });

  it("detaches all listeners via the returned cleanup", () => {
    const registry = new VaultRegistry();
    const { vault, off } = fakeVaultWithUpdates("v1");
    registry.register(vault);

    const cleanup = wireVaultUpdatesToWs(registry, { broadcast: vi.fn() });
    expect(off).not.toHaveBeenCalled();
    cleanup();
    expect(off).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// TESTS — registerVaultRoutes (express-like dev/test adapter)
// =============================================================================

type FakeHandler = (req?: unknown, res?: unknown) => unknown;

function makeFakeApp(): { app: RouteApp; routes: Map<string, FakeHandler> } {
  const routes = new Map<string, FakeHandler>();
  const app: RouteApp = {
    get: (path, handler) => { routes.set(`GET ${path}`, handler as FakeHandler); },
    post: (path, handler) => { routes.set(`POST ${path}`, handler as FakeHandler); },
  };
  return { app, routes };
}

describe("registerVaultRoutes (fake-app adapter)", () => {
  it("GET /api/vaults returns items without rootPath", () => {
    const { app, routes } = makeFakeApp();
    const registry = new VaultRegistry();
    registry.register(createFakeVault({ rootPath: "/Users/secret/project" }));
    registerVaultRoutes(app, registry);

    const result = routes.get("GET /api/vaults")!() as { items: unknown[] };
    expect(result).toEqual({ items: [{ id: "unity:abc12345", kind: "unity-project" }] });
    expect(JSON.stringify(result)).not.toContain("/Users/secret");
  });

  it("POST /api/vaults without a factory returns an error payload", async () => {
    const { app, routes } = makeFakeApp();
    registerVaultRoutes(app, new VaultRegistry());

    const result = await routes.get("POST /api/vaults")!({ body: { name: "ok", rootPath: "/tmp" } });
    expect(String((result as { error: string }).error)).toContain("VaultFactory not installed");
  });

  it.each([
    ["invalid name", { name: "a/b", rootPath: "/tmp" }, "invalid name"],
    ["relative rootPath", { name: "ok", rootPath: "relative" }, "rootPath must be absolute"],
    ["invalid kind", { name: "ok", rootPath: "/tmp", kind: "weird" }, "invalid kind"],
  ])("POST /api/vaults rejects %s", async (_label, body, expectedError) => {
    const { app, routes } = makeFakeApp();
    const factory: VaultFactory = { create: vi.fn(async () => createFakeVault()) };
    registerVaultRoutes(app, new VaultRegistry(), factory);

    const result = await routes.get("POST /api/vaults")!({ body });
    expect(result).toEqual({ error: expectedError });
  });

  it("POST /api/vaults rejects a nonexistent directory", async () => {
    const { app, routes } = makeFakeApp();
    const factory: VaultFactory = { create: vi.fn(async () => createFakeVault()) };
    registerVaultRoutes(app, new VaultRegistry(), factory);

    const result = await routes.get("POST /api/vaults")!({
      body: { name: "ok", rootPath: join(tmpdir(), "does-not-exist-xyz-007") },
    });
    expect(result).toEqual({ error: "path does not exist" });
  });

  it("POST /api/vaults registers on the happy path then rejects a duplicate", async () => {
    const { app, routes } = makeFakeApp();
    const registry = new VaultRegistry();
    const factory: VaultFactory = {
      create: vi.fn(async (spec: { id: string }) => createFakeVault({ id: spec.id })),
    };
    registerVaultRoutes(app, registry, factory);
    const dir = tmp.makeDir();

    const handler = routes.get("POST /api/vaults")!;
    const result = await handler({ body: { name: "My Vault", rootPath: dir, kind: "generic" } }) as Record<string, unknown>;
    expect(result).toMatchObject({ name: "My Vault", status: "indexing", symbolCount: 0 });
    expect(registry.get(result.id as string)).toBeDefined();

    const dup = await handler({ body: { name: "My Vault", rootPath: dir, kind: "generic" } });
    expect(dup).toEqual({ error: "vault already registered" });
  });
});

// =============================================================================
// TESTS — plan 004 hardening: search rate limiting
// (merged from the plan-004 executor's test file; adapted to this file's helpers)
// =============================================================================

describe("handleVaultRoutes — POST /api/vaults/:id/search rate limiting", () => {
  function searchCtx(): { ctx: RouteContext; vault: IVault } {
    const vault = createFakeVault({ id: "x" });
    const registry = { get: () => vault, list: () => [vault] };
    return { ctx: { vaultRegistry: registry } as unknown as RouteContext, vault };
  }

  it("returns 429 once the per-source limit is exhausted", async () => {
    resetVaultSearchRateLimiterForTests(2, 10_000);
    const { ctx } = searchCtx();

    for (let i = 0; i < 2; i++) {
      const res = createMockRes();
      const handled = handleVaultRoutes("/api/vaults/x/search", "POST", createStreamReqFrom({ text: "hi" }), res, ctx);
      expect(handled).toBe(true);
      await new Promise(setImmediate);
      expect((res as unknown as { statusCode: number }).statusCode).toBe(200);
    }

    const res = createMockRes();
    const handled = handleVaultRoutes("/api/vaults/x/search", "POST", createStreamReqFrom({ text: "hi" }), res, ctx);
    expect(handled).toBe(true);
    await new Promise(setImmediate);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(429);
    expect((res as unknown as { body: string }).body).toContain("rate limit exceeded");
  });

  it("isolates limits per source address", async () => {
    resetVaultSearchRateLimiterForTests(2, 10_000);
    const { ctx } = searchCtx();

    for (let i = 0; i < 2; i++) {
      const res = createMockRes();
      handleVaultRoutes("/api/vaults/x/search", "POST", createStreamReqFrom({ text: "hi" }), res, ctx);
      await new Promise(setImmediate);
      expect((res as unknown as { statusCode: number }).statusCode).toBe(200);
    }

    // Third request from a DIFFERENT source is still allowed.
    const res = createMockRes();
    const handled = handleVaultRoutes("/api/vaults/x/search", "POST", createStreamReqFrom({ text: "hi" }, "10.0.0.9"), res, ctx);
    expect(handled).toBe(true);
    await new Promise(setImmediate);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(200);
  });
});

// =============================================================================
// TESTS — plan 008: surface async vault init failures through the stats endpoint
// =============================================================================

/** Deferred promise so tests can settle a vault's init() on demand. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("vault init failure surfacing", () => {
  /**
   * End-to-end harness for handleVaultRoutes: real VaultRegistry, a temp dir
   * as rootPath, and a factory whose fake vault init() is a deferred promise
   * the test settles.
   */
  function setupInitHarness(): {
    registry: VaultRegistry;
    dir: string;
    init: ReturnType<typeof deferred>;
    post: () => Promise<{ res: MockRes & ServerResponse; id: string; rootPath: string }>;
    getStats: (id: string) => Promise<Record<string, unknown>>;
  } {
    const registry = new VaultRegistry();
    const dir = tmp.makeDir();
    const init = deferred();
    let createdSpec: { id: string; rootPath: string } | undefined;
    const factory: VaultFactory = {
      create: vi.fn(async (spec: { id: string; rootPath: string; kind: "unity" | "generic" }) => {
        createdSpec = spec;
        return createFakeVault({
          id: spec.id,
          rootPath: spec.rootPath,
          init: vi.fn(() => init.promise),
        });
      }),
    };
    const ctx = makeCtx({ vaultRegistry: registry, vaultFactory: factory });
    return {
      registry,
      dir,
      init,
      post: async () => {
        const res = createMockRes();
        const handled = handleVaultRoutes(
          "/api/vaults", "POST",
          createStreamReq(JSON.stringify({ name: "Init Vault", rootPath: dir, kind: "generic" })),
          res, ctx,
        );
        expect(handled).toBe(true);
        await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
        return { res, id: createdSpec!.id, rootPath: createdSpec!.rootPath };
      },
      getStats: async (id: string) => {
        const res = createMockRes();
        const handled = handleVaultRoutes(
          `/api/vaults/${id}/stats`, "GET", createMockReq(), res, ctx,
        );
        expect(handled).toBe(true);
        await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
        expect(res.statusCode).toBe(200);
        return responseJson(res);
      },
    };
  }

  it("reports status indexing in stats while init is unresolved", async () => {
    const h = setupInitHarness();
    const { res, id } = await h.post();
    expect(res.statusCode).toBe(201);
    expect(responseJson(res)).toMatchObject({ status: "indexing" });

    const stats = await h.getStats(id);
    expect(stats).toEqual({
      fileCount: 1, chunkCount: 2, lastIndexedAt: 123, dbBytes: 10,
      status: "indexing",
    });
  });

  it("reports status error with a redacted, capped message when init rejects", async () => {
    const h = setupInitHarness();
    const { id, rootPath } = await h.post();
    // Pad well past the 200-char cap so the truncation is actually exercised.
    h.init.reject(new Error(`embedding provider down at ${rootPath}/db ${"x".repeat(300)}`));
    await vi.waitFor(() => expect(h.registry.getInitState(id)?.status).toBe("error"));

    const stats = await h.getStats(id);
    expect(stats.status).toBe("error");
    expect(typeof stats.error).toBe("string");
    const message = stats.error as string;
    expect(message).not.toContain(rootPath);
    expect(message).toContain("<vault>");
    expect(message.length).toBe(200);
  });

  it("reports status ready with no error field once init resolves", async () => {
    const h = setupInitHarness();
    const { id } = await h.post();
    h.init.resolve();
    await vi.waitFor(() => expect(h.registry.getInitState(id)?.status).toBe("ready"));

    const stats = await h.getStats(id);
    expect(stats.status).toBe("ready");
    expect(stats).not.toHaveProperty("error");
  });

  it("back-compat: a directly registered vault has no status key in stats", async () => {
    const registry = new VaultRegistry();
    registry.register(createFakeVault({ id: "v1" }));
    const res = createMockRes();
    const handled = handleVaultRoutes(
      "/api/vaults/v1/stats", "GET", createMockReq(), res, makeCtx({ vaultRegistry: registry }),
    );
    expect(handled).toBe(true);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(responseJson(res)).toEqual({ fileCount: 1, chunkCount: 2, lastIndexedAt: 123, dbBytes: 10 });
    expect(responseJson(res)).not.toHaveProperty("status");
  });

  it("unregister clears the init state so a reused id has no stale error", async () => {
    const h = setupInitHarness();
    const { id, rootPath } = await h.post();
    h.init.reject(new Error(`init exploded at ${rootPath}`));
    await vi.waitFor(() => expect(h.registry.getInitState(id)?.status).toBe("error"));

    const delRes = createMockRes();
    handleVaultRoutes(
      `/api/vaults/${encodeURIComponent(id)}`, "DELETE", createMockReq(), delRes,
      makeCtx({ vaultRegistry: h.registry }),
    );
    expect(delRes.statusCode).toBe(200);
    expect(h.registry.getInitState(id)).toBeUndefined();

    // Re-register a vault with the same id directly (no POST) — stats must not
    // carry the stale error/status from the failed predecessor.
    h.registry.register(createFakeVault({ id }));
    const stats = await h.getStats(id);
    expect(stats).not.toHaveProperty("status");
    expect(stats).not.toHaveProperty("error");
  });

  it("registerVaultRoutes parity: stats follows the indexing/error/ready progression", async () => {
    const { app, routes } = makeFakeApp();
    const registry = new VaultRegistry();
    const inits = new Map<string, ReturnType<typeof deferred>>();
    const factory: VaultFactory = {
      create: vi.fn(async (spec: { id: string; rootPath: string; kind: "unity" | "generic" }) => {
        const d = deferred();
        inits.set(spec.id, d);
        return createFakeVault({ id: spec.id, rootPath: spec.rootPath, init: vi.fn(() => d.promise) });
      }),
    };
    registerVaultRoutes(app, registry, factory);
    const postHandler = routes.get("POST /api/vaults")!;
    const statsHandler = routes.get("GET /api/vaults/:id/stats")!;
    const getStats = async (id: string): Promise<Record<string, unknown>> =>
      await statsHandler({ params: { id } }) as Record<string, unknown>;

    // Vault A: indexing → ready.
    const dirA = tmp.makeDir();
    const a = await postHandler({ body: { name: "A", rootPath: dirA, kind: "generic" } }) as Record<string, unknown>;
    expect(a.status).toBe("indexing");
    const idA = a.id as string;
    expect((await getStats(idA)).status).toBe("indexing");
    inits.get(idA)!.resolve();
    await vi.waitFor(() => expect(registry.getInitState(idA)?.status).toBe("ready"));
    const readyStats = await getStats(idA);
    expect(readyStats.status).toBe("ready");
    expect(readyStats).not.toHaveProperty("error");

    // Vault B: indexing → error (redacted).
    const dirB = tmp.makeDir();
    const b = await postHandler({ body: { name: "B", rootPath: dirB, kind: "generic" } }) as Record<string, unknown>;
    const idB = b.id as string;
    expect((await getStats(idB)).status).toBe("indexing");
    const rootB = registry.get(idB)!.rootPath;
    inits.get(idB)!.reject(new Error(`db locked at ${rootB}/index.db`));
    await vi.waitFor(() => expect(registry.getInitState(idB)?.status).toBe("error"));
    const errorStats = await getStats(idB);
    expect(errorStats.status).toBe("error");
    expect(errorStats.error as string).not.toContain(rootB);
    expect(errorStats.error as string).toContain("<vault>");
  });
});

