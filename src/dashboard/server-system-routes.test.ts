import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerResponse } from "node:http";
import {
  handleSystemRoutes,
  serializeGoalTree,
  getLifecycleData,
  aggregateWeeklyCounters,
} from "./server-system-routes.js";
import {
  createMockReq,
  createMockRes,
  responseJson,
  type MockRes,
} from "./test-support/mock-http.js";
import type { RouteContext } from "./server-types.js";
import type { GoalTree, GoalNodeId } from "../goals/types.js";

vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  const stub = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { ...actual, getLogger: () => stub, getLoggerSafe: () => stub };
});

// We need the mock BEFORE the module imports it, so the mock factory
// also captures the ring-buffer stub used in GET /api/logs tests below.
const mockRingBuffer: Array<Record<string, unknown>> = [];
vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  const stub = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return {
    ...actual,
    getLogger: () => stub,
    getLoggerSafe: () => stub,
    getLogRingBuffer: () => mockRingBuffer,
  };
});

// =============================================================================
// HELPERS
// =============================================================================

function makeCtx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    metrics: {
      getSnapshot: vi.fn(() => ({
        toolCallCounts: {},
        toolErrorCounts: {},
        activeSessions: 0,
      })),
      getRecentToolErrors: vi.fn(() => ({})),
    },
    getMemoryStats: vi.fn(() => ({})),
    getAutonomousDefaults: vi.fn(() => ({})),
    ...overrides,
  } as unknown as RouteContext;
}

function noopMask(obj: Record<string, unknown>): Record<string, unknown> {
  return obj;
}

function route(
  url: string,
  method: string,
  ctx?: RouteContext,
): { handled: boolean; res: MockRes & ServerResponse } {
  const res = createMockRes();
  const handled = handleSystemRoutes(
    url,
    method,
    createMockReq(),
    res,
    ctx ?? makeCtx(),
    noopMask,
  );
  return { handled, res };
}

function makeGoalTree(rootStatus: "pending" | "executing" | "completed" | "failed" | "skipped" = "pending"): GoalTree {
  const rootId = "goal_root_001" as GoalNodeId;
  const nodes = new Map<GoalNodeId, GoalTree["nodes"] extends ReadonlyMap<GoalNodeId, infer V> ? V : never>();
  nodes.set(rootId, {
    id: rootId,
    parentId: null,
    task: "Root task",
    dependsOn: [],
    depth: 0,
    status: rootStatus,
    createdAt: 1000,
    updatedAt: 2000,
    startedAt: 1500,
    completedAt: undefined,
    retryCount: 0,
  });
  return {
    rootId,
    sessionId: "sess-abc",
    taskDescription: "Test goal",
    nodes,
    createdAt: 1000,
  };
}

// =============================================================================
// TESTS — handleSystemRoutes fall-through
// =============================================================================

describe("handleSystemRoutes — fall-through", () => {
  it("returns false for an unknown URL", () => {
    const { handled, res } = route("/api/unknown-xyz", "GET");
    expect(handled).toBe(false);
    expect((res as MockRes).end).not.toHaveBeenCalled();
  });
});

// =============================================================================
// TESTS — GET /api/goals
// =============================================================================

describe("GET /api/goals", () => {
  it("returns { trees: [] } when ctx.goalStorage is undefined", () => {
    const { handled, res } = route("/api/goals", "GET", makeCtx({ goalStorage: undefined }));
    expect(handled).toBe(true);
    expect(responseJson(res)).toEqual({ trees: [] });
  });

  it("returns { trees: [] } for an unknown rootId when goalStorage exists", () => {
    const goalStorage = {
      getTree: vi.fn(() => undefined),
      getTreesBySession: vi.fn(() => []),
    };
    const { handled, res } = route(
      "/api/goals?rootId=nonexistent",
      "GET",
      makeCtx({ goalStorage: goalStorage as unknown as RouteContext["goalStorage"] }),
    );
    expect(handled).toBe(true);
    expect(responseJson(res)).toEqual({ trees: [] });
    expect(goalStorage.getTree).toHaveBeenCalledWith("nonexistent");
  });
});

// =============================================================================
// TESTS — GET /api/agent-metrics
// =============================================================================

describe("GET /api/agent-metrics", () => {
  it("returns 503 when ctx.metricsStorage is undefined", () => {
    const { handled, res } = route("/api/agent-metrics", "GET", makeCtx({ metricsStorage: undefined }));
    expect(handled).toBe(true);
    expect((res as MockRes).statusCode).toBe(503);
    expect(responseJson(res)).toMatchObject({ error: expect.any(String) as string });
  });

  it("returns 400 for an invalid type param", () => {
    const metricsStorage = { getAggregation: vi.fn(() => ({})) };
    const { handled, res } = route(
      "/api/agent-metrics?type=bogus",
      "GET",
      makeCtx({ metricsStorage: metricsStorage as unknown as RouteContext["metricsStorage"] }),
    );
    expect(handled).toBe(true);
    expect((res as MockRes).statusCode).toBe(400);
    expect(responseJson(res)).toMatchObject({ error: expect.any(String) as string });
  });

  it("returns 400 for an invalid status param", () => {
    const metricsStorage = { getAggregation: vi.fn(() => ({})) };
    const { handled, res } = route(
      "/api/agent-metrics?status=bogus",
      "GET",
      makeCtx({ metricsStorage: metricsStorage as unknown as RouteContext["metricsStorage"] }),
    );
    expect(handled).toBe(true);
    expect((res as MockRes).statusCode).toBe(400);
    expect(responseJson(res)).toMatchObject({ error: expect.any(String) as string });
  });
});

// =============================================================================
// TESTS — disabled-subsystem routes returning { enabled: false }
// =============================================================================

describe("GET /api/agents — { enabled: false } without agentManager", () => {
  it("returns { enabled: false } when agentManager is absent", () => {
    const { handled, res } = route("/api/agents", "GET", makeCtx({ agentManager: undefined }));
    expect(handled).toBe(true);
    expect(responseJson(res)).toEqual({ enabled: false });
  });
});

describe("GET /api/delegations — { enabled: false } without delegationLog", () => {
  it("returns { enabled: false } when delegationLog is absent", () => {
    const { handled, res } = route("/api/delegations", "GET", makeCtx({ delegationLog: undefined }));
    expect(handled).toBe(true);
    expect(responseJson(res)).toEqual({ enabled: false });
  });
});

describe("GET /api/consolidation — { enabled: false } without consolidationEngine", () => {
  it("returns { enabled: false } when consolidationEngine is absent", () => {
    const { handled, res } = route("/api/consolidation", "GET", makeCtx({ consolidationEngine: undefined }));
    expect(handled).toBe(true);
    expect(responseJson(res)).toEqual({ enabled: false });
  });
});

describe("GET /api/deployment — { enabled: false } without deploymentExecutor", () => {
  it("returns { enabled: false } when deploymentExecutor is absent", () => {
    const { handled, res } = route("/api/deployment", "GET", makeCtx({ deploymentExecutor: undefined }));
    expect(handled).toBe(true);
    expect(responseJson(res)).toEqual({ enabled: false });
  });
});

// =============================================================================
// TESTS — GET /api/system/boot
// =============================================================================

describe("GET /api/system/boot", () => {
  it("returns { bootReport: null } when bootReport is undefined", () => {
    const { handled, res } = route("/api/system/boot", "GET", makeCtx({ bootReport: undefined }));
    expect(handled).toBe(true);
    expect(responseJson(res)).toEqual({ bootReport: null });
  });
});

// =============================================================================
// TESTS — GET /api/channels
// =============================================================================

describe("GET /api/channels", () => {
  it("returns channel info with enabled:false when no channel in ctx", () => {
    const { handled, res } = route("/api/channels", "GET", makeCtx({ channel: undefined }));
    expect(handled).toBe(true);
    const body = responseJson(res);
    expect(body).toHaveProperty("channels");
    const channels = body["channels"] as Array<Record<string, unknown>>;
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      enabled: false,
      clients: 0,
    });
  });
});

// =============================================================================
// TESTS — GET /api/sessions
// =============================================================================

describe("GET /api/sessions", () => {
  it("returns { sessions: [], count: 0 } with no orchestratorSessions and no taskManager", () => {
    const { handled, res } = route(
      "/api/sessions",
      "GET",
      makeCtx({ orchestratorSessions: undefined, taskManager: undefined }),
    );
    expect(handled).toBe(true);
    expect(responseJson(res)).toEqual({ sessions: [], count: 0 });
  });
});

// =============================================================================
// TESTS — GET /api/logs
// =============================================================================

describe("GET /api/logs", () => {
  beforeEach(() => {
    mockRingBuffer.length = 0;
  });

  it("returns the ring buffer contents as-is without re-sanitizing", () => {
    // Entries in the buffer already had redaction applied at write time.
    // The route must return them verbatim — no second-pass sanitization.
    const entry = {
      level: "info",
      message: "Connected to sk-proj-REDACTED endpoint",
      timestamp: 1700000000000,
    };
    mockRingBuffer.push(entry);

    const { handled, res } = route("/api/logs", "GET");
    expect(handled).toBe(true);
    const body = responseJson(res);
    expect(body["count"]).toBe(1);
    const logs = body["logs"] as Array<Record<string, unknown>>;
    expect(logs).toHaveLength(1);
    // The entry is returned verbatim — including any already-redacted text.
    expect(logs[0]).toEqual(entry);
  });

  it("returns count matching the number of ring-buffer entries", () => {
    mockRingBuffer.push({ level: "debug", message: "a", timestamp: 1 });
    mockRingBuffer.push({ level: "info", message: "b", timestamp: 2 });
    mockRingBuffer.push({ level: "warn", message: "c", timestamp: 3 });

    const { handled, res } = route("/api/logs", "GET");
    expect(handled).toBe(true);
    const body = responseJson(res);
    expect(body["count"]).toBe(3);
    expect((body["logs"] as unknown[]).length).toBe(3);
  });
});

// =============================================================================
// TESTS — GET /api/identity
// =============================================================================

describe("GET /api/identity", () => {
  it("returns fallback identity with agentName and deps:null when no identityManager", () => {
    const prevEnv = process.env["STRADA_AGENT_NAME"];
    process.env["STRADA_AGENT_NAME"] = "Test Brain";

    const { handled, res } = route(
      "/api/identity",
      "GET",
      makeCtx({ identityManager: undefined, stradaDeps: undefined }),
    );
    expect(handled).toBe(true);
    const body = responseJson(res);
    expect(body["deps"]).toBeNull();
    const identity = body["identity"] as Record<string, unknown>;
    expect(identity["agentName"]).toBe("Test Brain");

    // Restore
    if (prevEnv === undefined) {
      delete process.env["STRADA_AGENT_NAME"];
    } else {
      process.env["STRADA_AGENT_NAME"] = prevEnv;
    }
  });

  it("falls back to 'Strada Brain' when STRADA_AGENT_NAME is not set", () => {
    const prevEnv = process.env["STRADA_AGENT_NAME"];
    delete process.env["STRADA_AGENT_NAME"];

    const { handled, res } = route(
      "/api/identity",
      "GET",
      makeCtx({ identityManager: undefined, stradaDeps: undefined }),
    );
    expect(handled).toBe(true);
    const body = responseJson(res);
    const identity = body["identity"] as Record<string, unknown>;
    expect(identity["agentName"]).toBe("Strada Brain");

    // Restore
    if (prevEnv !== undefined) {
      process.env["STRADA_AGENT_NAME"] = prevEnv;
    }
  });
});

// =============================================================================
// TESTS — GET /api/metrics
// =============================================================================

describe("GET /api/metrics", () => {
  it("returns the metrics snapshot from ctx.metrics.getSnapshot", () => {
    const snapshot = {
      toolCallCounts: { bash: 5 },
      toolErrorCounts: {},
      activeSessions: 2,
    };
    const ctx = makeCtx({
      metrics: {
        getSnapshot: vi.fn(() => snapshot),
        getRecentToolErrors: vi.fn(() => ({})),
      } as unknown as RouteContext["metrics"],
      taskManager: undefined,
    });

    const { handled, res } = route("/api/metrics", "GET", ctx);
    expect(handled).toBe(true);
    const body = responseJson(res);
    expect(body["activeSessions"]).toBe(2);
    expect(body["toolCallCounts"]).toEqual({ bash: 5 });
  });

  it("overrides activeSessions with activeForegroundTasks when it is larger", () => {
    const snapshot = {
      toolCallCounts: {},
      toolErrorCounts: {},
      activeSessions: 1,
    };
    const taskManager = {
      countActiveForegroundTasks: vi.fn(() => 4),
      listAllActiveTasks: vi.fn(() => []),
    };
    const ctx = makeCtx({
      metrics: {
        getSnapshot: vi.fn(() => snapshot),
        getRecentToolErrors: vi.fn(() => ({})),
      } as unknown as RouteContext["metrics"],
      taskManager: taskManager as unknown as RouteContext["taskManager"],
    });

    const { handled, res } = route("/api/metrics", "GET", ctx);
    expect(handled).toBe(true);
    expect((responseJson(res))["activeSessions"]).toBe(4);
  });
});

// =============================================================================
// PURE UNIT TESTS — serializeGoalTree
// =============================================================================

describe("serializeGoalTree", () => {
  it("serializes a minimal GoalTree with one node", () => {
    const tree = makeGoalTree("pending");
    const result = serializeGoalTree(tree);

    expect(result["rootId"]).toBe("goal_root_001");
    expect(result["sessionId"]).toBe("sess-abc");
    expect(result["nodeCount"]).toBe(1);
    expect(result["status"]).toBe("pending");

    const progress = result["progress"] as Record<string, unknown>;
    expect(typeof progress["completed"]).toBe("number");
    expect(typeof progress["total"]).toBe("number");
    expect(typeof progress["percentage"]).toBe("number");

    const nodes = result["nodes"] as Array<Record<string, unknown>>;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      id: "goal_root_001",
      task: "Root task",
      status: "pending",
      depth: 0,
      dependsOn: [],
      parentId: null,
      retryCount: 0,
      startedAt: 1500,
      completedAt: null,
    });
  });

  it("reflects the root node status in the serialized status field", () => {
    const tree = makeGoalTree("completed");
    const result = serializeGoalTree(tree);
    expect(result["status"]).toBe("completed");
  });
});

// =============================================================================
// PURE UNIT TESTS — aggregateWeeklyCounters
// =============================================================================

describe("aggregateWeeklyCounters", () => {
  it("returns [] for an empty input array", () => {
    expect(aggregateWeeklyCounters([])).toEqual([]);
  });

  it("aggregates mixed events for two week starts and sorts descending", () => {
    const week1 = 1_700_000_000;
    const week2 = 1_700_604_800; // one week later

    const counters = [
      { weekStart: week1, eventType: "promoted", count: 3 },
      { weekStart: week1, eventType: "deprecated", count: 1 },
      { weekStart: week1, eventType: "cooling_started", count: 2 },
      { weekStart: week1, eventType: "cooling_recovered", count: 0 },
      { weekStart: week2, eventType: "promoted", count: 5 },
      { weekStart: week2, eventType: "deprecated", count: 2 },
      { weekStart: week2, eventType: "cooling_started", count: 0 },
      { weekStart: week2, eventType: "cooling_recovered", count: 4 },
    ];

    const result = aggregateWeeklyCounters(counters);

    expect(result).toHaveLength(2);
    // Sorted descending by weekStart — newer week first.
    expect(result[0]!.weekStart).toBe(week2);
    expect(result[0]).toMatchObject({
      weekStart: week2,
      promoted: 5,
      deprecated: 2,
      coolingStarted: 0,
      coolingRecovered: 4,
    });
    expect(result[1]).toMatchObject({
      weekStart: week1,
      promoted: 3,
      deprecated: 1,
      coolingStarted: 2,
      coolingRecovered: 0,
    });
  });

  it("ignores unknown event types silently", () => {
    const counters = [
      { weekStart: 1000, eventType: "promoted", count: 1 },
      { weekStart: 1000, eventType: "unknown_event", count: 99 },
    ];
    const result = aggregateWeeklyCounters(counters);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ promoted: 1, deprecated: 0, coolingStarted: 0, coolingRecovered: 0 });
  });
});

// =============================================================================
// PURE UNIT TESTS — getLifecycleData
// =============================================================================

describe("getLifecycleData", () => {
  it("returns null when learningStorage is absent", () => {
    const result = getLifecycleData({ learningStorage: undefined });
    expect(result).toBeNull();
  });

  it("returns statusCounts breakdown when learningStorage.getInstincts returns mixed statuses", () => {
    const instincts = [
      { status: "permanent", coolingStartedAt: null },
      { status: "permanent", coolingStartedAt: null },
      { status: "active", coolingStartedAt: null },
      { status: "active", coolingStartedAt: null },
      { status: "active", coolingStartedAt: Date.now() }, // cooling
      { status: "proposed", coolingStartedAt: null },
      { status: "deprecated", coolingStartedAt: null },
      { status: "deprecated", coolingStartedAt: null },
    ];

    const learningStorage = {
      getInstincts: vi.fn(() => instincts),
      getWeeklyCounters: vi.fn(() => []),
    };

    const result = getLifecycleData({
      learningStorage: learningStorage as unknown as RouteContext["learningStorage"],
    });

    expect(result).not.toBeNull();
    expect(result!.statusCounts).toEqual({
      permanent: 2,
      active: 2,   // active AND coolingStartedAt == null
      cooling: 1,  // coolingStartedAt != null
      proposed: 1,
      deprecated: 2,
    });
    expect(Array.isArray(result!.weeklyTrends)).toBe(true);
  });

  it("returns null when learningStorage.getInstincts throws", () => {
    const learningStorage = {
      getInstincts: vi.fn(() => { throw new Error("storage error"); }),
      getWeeklyCounters: vi.fn(() => []),
    };
    const result = getLifecycleData({
      learningStorage: learningStorage as unknown as RouteContext["learningStorage"],
    });
    expect(result).toBeNull();
  });
});
