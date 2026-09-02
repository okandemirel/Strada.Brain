import { describe, it, expect, vi } from "vitest";
import { handleDaemonRoutes, buildTriggerHistory } from "./server-daemon-routes.js";
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
    lastUpdateCheckMs: 0,
    setLastUpdateCheckMs: vi.fn(),
    startupNotices: [],
    ...overrides,
  } as unknown as RouteContext;
}

function route(
  url: string,
  method: string,
  ctx?: RouteContext,
): { handled: boolean; res: MockRes & import("node:http").ServerResponse } {
  const res = createMockRes();
  const handled = handleDaemonRoutes(url, method, createMockReq(), res, ctx ?? makeCtx());
  return { handled, res };
}

// =============================================================================
// TESTS — fall-through
// =============================================================================

describe("handleDaemonRoutes — fall-through", () => {
  it("returns false for an unknown URL", () => {
    const { handled, res } = route("/api/unknown-xyz", "GET");
    expect(handled).toBe(false);
    expect(res.end).not.toHaveBeenCalled();
  });

  it("returns false for GET /api/vaults (other handler's domain)", () => {
    const { handled } = route("/api/vaults", "GET");
    expect(handled).toBe(false);
  });
});

// =============================================================================
// TESTS — daemon approval
// =============================================================================

describe("handleDaemonRoutes — POST /api/daemon/approvals/:id/(approve|deny)", () => {
  it("returns 503 when daemonApprovalQueue is not in ctx", () => {
    const { handled, res } = route("/api/daemon/approvals/abc/approve", "POST");
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(responseJson(res)).toMatchObject({ error: "Daemon not active" });
  });

  it("returns 404 for an unknown approval id", () => {
    const queue = { getById: vi.fn(() => null), approve: vi.fn(), deny: vi.fn() };
    const ctx = makeCtx({ daemonApprovalQueue: queue as unknown as RouteContext["daemonApprovalQueue"] });
    const { handled, res } = route("/api/daemon/approvals/missing-id/approve", "POST", ctx);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
    expect(responseJson(res)).toMatchObject({ error: "Approval not found" });
  });

  it("approves an existing entry and returns { status: 'approved' }", () => {
    const entry = { id: "e1", toolName: "shell_exec", triggerName: "cron", status: "pending", createdAt: Date.now(), expiresAt: null };
    const queue = {
      getById: vi.fn(() => entry),
      approve: vi.fn(() => ({ applied: true, status: "approved" })),
      deny: vi.fn(() => ({ applied: true, status: "denied" })),
    };
    const ctx = makeCtx({ daemonApprovalQueue: queue as unknown as RouteContext["daemonApprovalQueue"] });
    const { handled, res } = route("/api/daemon/approvals/e1/approve", "POST", ctx);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toEqual({ status: "approved" });
    expect(queue.approve).toHaveBeenCalledWith("e1", "dashboard");
  });

  it("returns 409 naming the actual status when the decision did not land (audited 2026-09-02)", () => {
    // An expired (auto-denied) entry is still fetchable by id; approving it
    // must be refused, never answered with { status: "approved" }.
    const entry = { id: "e9", toolName: "deployment", triggerName: "deploy-readiness", status: "expired", createdAt: 0, expiresAt: 1 };
    const queue = {
      getById: vi.fn(() => entry),
      approve: vi.fn(() => ({ applied: false, status: "expired" })),
      deny: vi.fn(() => ({ applied: false, status: "expired" })),
    };
    const ctx = makeCtx({ daemonApprovalQueue: queue as unknown as RouteContext["daemonApprovalQueue"] });
    const { handled, res } = route("/api/daemon/approvals/e9/approve", "POST", ctx);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(409);
    expect(responseJson(res)).toMatchObject({ error: expect.stringContaining("expired") });
  });

  it("denies an existing entry and returns { status: 'denied' }", () => {
    const entry = { id: "e2", toolName: "shell_exec", triggerName: "cron", status: "pending", createdAt: Date.now(), expiresAt: null };
    const queue = {
      getById: vi.fn(() => entry),
      approve: vi.fn(() => ({ applied: true, status: "approved" })),
      deny: vi.fn(() => ({ applied: true, status: "denied" })),
    };
    const ctx = makeCtx({ daemonApprovalQueue: queue as unknown as RouteContext["daemonApprovalQueue"] });
    const { handled, res } = route("/api/daemon/approvals/e2/deny", "POST", ctx);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toEqual({ status: "denied" });
    expect(queue.deny).toHaveBeenCalledWith("e2", "dashboard");
  });

  it("returns 404 for a malformed approval URL (no action segment)", () => {
    const queue = { getById: vi.fn(), approve: vi.fn(), deny: vi.fn() };
    const ctx = makeCtx({ daemonApprovalQueue: queue as unknown as RouteContext["daemonApprovalQueue"] });
    const { handled, res } = route("/api/daemon/approvals/e1", "POST", ctx);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });
});

// =============================================================================
// TESTS — daemon start / stop
// =============================================================================

describe("handleDaemonRoutes — POST /api/daemon/start|stop", () => {
  it("returns 503 when daemonHeartbeatLoop is not in ctx", () => {
    const { handled, res } = route("/api/daemon/start", "POST");
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
  });

  it("starts a stopped daemon and returns { status: 'started' }", () => {
    const loop = { isRunning: vi.fn(() => false), start: vi.fn(), stop: vi.fn() };
    const ctx = makeCtx({ daemonHeartbeatLoop: loop as unknown as RouteContext["daemonHeartbeatLoop"] });
    const { handled, res } = route("/api/daemon/start", "POST", ctx);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toEqual({ status: "started" });
    expect(loop.start).toHaveBeenCalled();
  });

  it("returns { status: 'already_running' } when daemon is already running", () => {
    const loop = { isRunning: vi.fn(() => true), start: vi.fn(), stop: vi.fn() };
    const ctx = makeCtx({ daemonHeartbeatLoop: loop as unknown as RouteContext["daemonHeartbeatLoop"] });
    const { handled, res } = route("/api/daemon/start", "POST", ctx);
    expect(handled).toBe(true);
    expect(responseJson(res)).toEqual({ status: "already_running" });
    expect(loop.start).not.toHaveBeenCalled();
  });

  it("stops a running daemon and returns { status: 'stopped' }", () => {
    const loop = { isRunning: vi.fn(() => true), start: vi.fn(), stop: vi.fn() };
    const ctx = makeCtx({ daemonHeartbeatLoop: loop as unknown as RouteContext["daemonHeartbeatLoop"] });
    const { handled, res } = route("/api/daemon/stop", "POST", ctx);
    expect(handled).toBe(true);
    expect(responseJson(res)).toEqual({ status: "stopped" });
    expect(loop.stop).toHaveBeenCalled();
  });

  it("returns { status: 'already_stopped' } when daemon is already stopped", () => {
    const loop = { isRunning: vi.fn(() => false), start: vi.fn(), stop: vi.fn() };
    const ctx = makeCtx({ daemonHeartbeatLoop: loop as unknown as RouteContext["daemonHeartbeatLoop"] });
    const { handled, res } = route("/api/daemon/stop", "POST", ctx);
    expect(handled).toBe(true);
    expect(responseJson(res)).toEqual({ status: "already_stopped" });
    expect(loop.stop).not.toHaveBeenCalled();
  });
});

// =============================================================================
// TESTS — GET /api/daemon
// =============================================================================

describe("handleDaemonRoutes — GET /api/daemon", () => {
  it("returns configured:false when no daemonHeartbeatLoop in ctx", () => {
    const { handled, res } = route("/api/daemon", "GET");
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = responseJson(res);
    expect(body.running).toBe(false);
    expect(body.configured).toBe(false);
    expect(body.triggers).toEqual([]);
    expect(body.approvalQueue).toEqual([]);
  });

  it("returns configured daemon status with triggers and approval queue", () => {
    const loop = {
      isRunning: vi.fn(() => true),
      getDaemonStatus: vi.fn(() => ({
        running: true,
        intervalMs: 60000,
        budgetUsage: { usedUsd: 1.5, limitUsd: 10, pct: 15 },
      })),
      getCircuitBreaker: vi.fn(() => ({ getState: vi.fn(() => "CLOSED") })),
    };
    const trigger = {
      metadata: { name: "test-trigger", type: "schedule" },
      getState: vi.fn(() => "active"),
      getNextRun: vi.fn(() => new Date("2026-01-01T00:00:00Z")),
    };
    const queue = { getPending: vi.fn(() => []) };
    const registry = { getAll: vi.fn(() => [trigger]) };
    const ctx = makeCtx({
      daemonHeartbeatLoop: loop as unknown as RouteContext["daemonHeartbeatLoop"],
      daemonApprovalQueue: queue as unknown as RouteContext["daemonApprovalQueue"],
      daemonRegistry: registry as unknown as RouteContext["daemonRegistry"],
    });
    const { handled, res } = route("/api/daemon", "GET", ctx);
    expect(handled).toBe(true);
    const body = responseJson(res);
    expect(body.configured).toBe(true);
    expect(body.running).toBe(true);
    expect(Array.isArray(body.triggers)).toBe(true);
    expect((body.triggers as unknown[]).length).toBe(1);
    const t = (body.triggers as Record<string, unknown>[])[0]!;
    expect(t.name).toBe("test-trigger");
    expect(t.type).toBe("schedule");
    expect(t.nextRun).toBe("2026-01-01T00:00:00.000Z");
  });
});

// =============================================================================
// TESTS — GET /api/triggers
// =============================================================================

describe("handleDaemonRoutes — GET /api/triggers", () => {
  it("returns empty list when no daemonRegistry", () => {
    const { handled, res } = route("/api/triggers", "GET");
    expect(handled).toBe(true);
    expect(responseJson(res)).toEqual({ triggers: [] });
  });

  it("maps triggers with state and nextRun", () => {
    const trigger = {
      metadata: { name: "webhook-1", type: "webhook" },
      getState: vi.fn(() => "active"),
      getNextRun: vi.fn(() => null),
    };
    const registry = { getAll: vi.fn(() => [trigger]) };
    const ctx = makeCtx({ daemonRegistry: registry as unknown as RouteContext["daemonRegistry"] });
    const { handled, res } = route("/api/triggers", "GET", ctx);
    expect(handled).toBe(true);
    const body = responseJson(res);
    const list = body.triggers as Record<string, unknown>[];
    expect(list.length).toBe(1);
    expect(list[0]!.name).toBe("webhook-1");
    expect(list[0]!.enabled).toBe(true);
    expect(list[0]!.nextRun).toBeNull();
  });

  it("marks disabled triggers as not enabled", () => {
    const trigger = {
      metadata: { name: "t1", type: "schedule" },
      getState: vi.fn(() => "disabled"),
      getNextRun: vi.fn(() => null),
    };
    const registry = { getAll: vi.fn(() => [trigger]) };
    const ctx = makeCtx({ daemonRegistry: registry as unknown as RouteContext["daemonRegistry"] });
    const { handled, res } = route("/api/triggers", "GET", ctx);
    const list = (responseJson(res).triggers as Record<string, unknown>[]);
    expect(list[0]!.enabled).toBe(false);
  });
});

// =============================================================================
// TESTS — POST /api/update
// =============================================================================

describe("handleDaemonRoutes — POST /api/update", () => {
  it("returns 503 when no autoUpdater in ctx", () => {
    const { handled, res } = route("/api/update", "POST");
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
  });

  it("returns 429 when update check requested within 60s", () => {
    const updater = { requestImmediateCheck: vi.fn().mockResolvedValue({ available: false, currentVersion: "1.0", latestVersion: "1.0" }) };
    const ctx = makeCtx({
      autoUpdater: updater as unknown as RouteContext["autoUpdater"],
      lastUpdateCheckMs: Date.now() - 10_000, // 10s ago, within 60s window
    });
    const { handled, res } = route("/api/update", "POST", ctx);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(429);
  });

  it("calls autoUpdater.requestImmediateCheck and returns up_to_date when no update", async () => {
    const updater = {
      requestImmediateCheck: vi.fn().mockResolvedValue({
        available: false,
        currentVersion: "4.2.300",
        latestVersion: "4.2.300",
      }),
    };
    const ctx = makeCtx({
      autoUpdater: updater as unknown as RouteContext["autoUpdater"],
      lastUpdateCheckMs: 0,
    });
    const res = createMockRes();
    handleDaemonRoutes("/api/update", "POST", createMockReq(), res, ctx);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(responseJson(res)).toMatchObject({ status: "up_to_date" });
  });
});

// =============================================================================
// TESTS — buildTriggerHistory (pure helper)
// =============================================================================

describe("buildTriggerHistory", () => {
  it("returns empty fires array when daemonStorage is not in ctx", () => {
    const trigger = { metadata: { name: "t1", type: "schedule" } };
    const result = buildTriggerHistory(
      [trigger as unknown as Parameters<typeof buildTriggerHistory>[0][0]],
      {} as Parameters<typeof buildTriggerHistory>[1],
    );
    expect(result).toEqual([{ triggerName: "t1", type: "schedule", fires: [] }]);
  });

  it("maps fire history from daemonStorage", () => {
    const trigger = { metadata: { name: "t2", type: "webhook" } };
    const storage = {
      getTriggerFireHistory: vi.fn(() => [
        { timestamp: 1700000000000, result: "success", durationMs: 120 },
        { timestamp: 1700000001000, result: "error", durationMs: null },
      ]),
    };
    const result = buildTriggerHistory(
      [trigger as unknown as Parameters<typeof buildTriggerHistory>[0][0]],
      { daemonStorage: storage as unknown as RouteContext["daemonStorage"], historyDepth: 10 },
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.fires).toHaveLength(2);
    expect(result[0]!.fires[0]!.result).toBe("success");
    expect(result[0]!.fires[0]!.durationMs).toBe(120);
    expect(result[0]!.fires[1]!.result).toBe("error");
    expect(result[0]!.fires[1]!.durationMs).toBeNull();
  });

  it("returns empty fires when daemonStorage.getTriggerFireHistory throws", () => {
    const trigger = { metadata: { name: "t3", type: "schedule" } };
    const storage = {
      getTriggerFireHistory: vi.fn(() => { throw new Error("db locked"); }),
    };
    const result = buildTriggerHistory(
      [trigger as unknown as Parameters<typeof buildTriggerHistory>[0][0]],
      { daemonStorage: storage as unknown as RouteContext["daemonStorage"] },
    );
    expect(result[0]!.fires).toEqual([]);
  });
});
