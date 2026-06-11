import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
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

/** Request that is never read (GET/DELETE routes). */
function createMockReq(): IncomingMessage {
  return {} as IncomingMessage;
}

/**
 * Vault POST routes read the body themselves via `for await (const c of req)`,
 * so the mock must be a real async-iterable stream, not a bare EventEmitter.
 */
function createStreamReq(body: string): IncomingMessage {
  return Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
}

function responseJson(res: MockRes & ServerResponse): Record<string, unknown> {
  return JSON.parse((res as MockRes).body) as Record<string, unknown>;
}

function makeCtx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    lastModelRefreshMs: 0,
    setLastModelRefreshMs: vi.fn(),
    readJsonBody: vi.fn(async () => null),
    ...overrides,
  } as unknown as RouteContext;
}

function fakeVault(overrides: Partial<IVault> = {}): IVault {
  return {
    id: "unity:abc12345",
    kind: "unity-project",
    rootPath: "/tmp/fake-root",
    init: vi.fn(async () => {}),
    sync: vi.fn(async () => ({ changed: 0, durationMs: 1 })),
    rebuild: vi.fn(async () => {}),
    query: vi.fn(async () => ({ hits: [], budgetUsed: 0, truncated: false })),
    stats: vi.fn(async () => ({ fileCount: 1, chunkCount: 2, lastIndexedAt: 123, dbBytes: 10 })),
    dispose: vi.fn(async () => {}),
    listFiles: vi.fn(() => []),
    readFile: vi.fn(async () => "body"),
    onUpdate: vi.fn(() => () => {}),
    ...overrides,
  } as unknown as IVault;
}

/** Fake vault whose onUpdate listeners can be triggered from the test. */
function fakeVaultWithUpdates(id: string): {
  vault: IVault;
  emit: (p: { vaultId: string; changedPaths: string[] }) => void;
  off: ReturnType<typeof vi.fn>;
} {
  const listeners: Array<(p: { vaultId: string; changedPaths: string[] }) => void> = [];
  const off = vi.fn();
  const vault = fakeVault({
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

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-routes-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

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
    registry.register(fakeVault({ rootPath: "/Users/secret/project" }));
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
        return fakeVault({ id: spec.id });
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
    const dir = makeTmpDir();
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
    const vault = fakeVault();
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
    vault = fakeVault({ id: "v1" });
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
    vault = fakeVault({ id: "v1" });
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
    const vault = fakeVault({
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
    registry.register(fakeVault({ rootPath: "/Users/secret/project" }));
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
    const factory: VaultFactory = { create: vi.fn(async () => fakeVault()) };
    registerVaultRoutes(app, new VaultRegistry(), factory);

    const result = await routes.get("POST /api/vaults")!({ body });
    expect(result).toEqual({ error: expectedError });
  });

  it("POST /api/vaults rejects a nonexistent directory", async () => {
    const { app, routes } = makeFakeApp();
    const factory: VaultFactory = { create: vi.fn(async () => fakeVault()) };
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
      create: vi.fn(async (spec: { id: string }) => fakeVault({ id: spec.id })),
    };
    registerVaultRoutes(app, registry, factory);
    const dir = makeTmpDir();

    const handler = routes.get("POST /api/vaults")!;
    const result = await handler({ body: { name: "My Vault", rootPath: dir, kind: "generic" } }) as Record<string, unknown>;
    expect(result).toMatchObject({ name: "My Vault", status: "indexing", symbolCount: 0 });
    expect(registry.get(result.id as string)).toBeDefined();

    const dup = await handler({ body: { name: "My Vault", rootPath: dir, kind: "generic" } });
    expect(dup).toEqual({ error: "vault already registered" });
  });
});

// =============================================================================
// TESTS — plan 004 hardening: search rate limiting + encoded-NUL path check
// (merged from the plan-004 executor's test file; adapted to this file's helpers)
// =============================================================================

/** Stream request carrying a source address, for per-IP rate-limit cases. */
function createStreamReqFrom(body: unknown, remoteAddress = "127.0.0.1"): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
  return Object.assign(stream, {
    socket: { remoteAddress },
    headers: {},
  }) as unknown as IncomingMessage;
}

describe("handleVaultRoutes — POST /api/vaults/:id/search rate limiting", () => {
  function searchCtx(): { ctx: RouteContext; vault: IVault } {
    const vault = fakeVault({ id: "x" });
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

describe("handleVaultRoutes — GET /api/vaults/:id/file encoded-NUL validation", () => {
  it("rejects URL-encoded null bytes in the path with 400", async () => {
    const vault = fakeVault({ id: "x" });
    const ctx = { vaultRegistry: { get: () => vault, list: () => [vault] } } as unknown as RouteContext;
    const res = createMockRes();
    // %2500 in the URL decodes to a literal "%00" in the query value.
    const handled = handleVaultRoutes("/api/vaults/x/file?path=%2500evil.md", "GET", createMockReq(), res, ctx);
    expect(handled).toBe(true);
    await new Promise(setImmediate);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(400);
    expect(vault.readFile).not.toHaveBeenCalled();
  });

  it("accepts a normal relative path and reaches the vault", async () => {
    const vault = fakeVault({ id: "x" });
    const ctx = { vaultRegistry: { get: () => vault, list: () => [vault] } } as unknown as RouteContext;
    const res = createMockRes();
    const handled = handleVaultRoutes("/api/vaults/x/file?path=notes/readme.md", "GET", createMockReq(), res, ctx);
    expect(handled).toBe(true);
    await new Promise(setImmediate);
    expect(vault.readFile).toHaveBeenCalledWith("notes/readme.md");
    expect((res as unknown as { statusCode: number }).statusCode).toBe(200);
  });
});
