import { describe, it, expect, vi, afterEach } from "vitest";
import { DashboardServer } from "./server.js";
import { MetricsCollector } from "./metrics.js";
import type { MetricsAggregation } from "../metrics/metrics-types.js";
import type { MetricsStorage } from "../metrics/metrics-storage.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("DashboardServer", () => {
  let server: DashboardServer | null = null;

  /** Start server with EPERM guard for sandboxed environments */
  async function safeStart(srv: DashboardServer): Promise<boolean> {
    try {
      await srv.start();
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        return false;
      }
      throw err;
    }
  }

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it("serves health endpoint", async () => {
    const metrics = new MetricsCollector();
    server = new DashboardServer(0, metrics, () => undefined);

    // Use port 0 to get random available port
    if (!await safeStart(server)) return;

    // Get the actual port from the server
    const addr = (server as unknown as { server: { address: () => { port: number } } }).server.address();
    if (!addr || typeof addr === "string") return;

    const res = await fetch(`http://localhost:${addr.port}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
  });

  it("serves metrics endpoint", async () => {
    const metrics = new MetricsCollector();
    metrics.recordMessage();
    metrics.recordTokenUsage(100, 50, "claude");

    server = new DashboardServer(0, metrics, () => undefined);
    if (!await safeStart(server)) return;

    const addr = (server as unknown as { server: { address: () => { port: number } } }).server.address();
    if (!addr || typeof addr === "string") return;

    const res = await fetch(`http://localhost:${addr.port}/api/metrics`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.totalMessages).toBe(1);
    expect(data.totalTokens.input).toBe(100);
    expect(data.providerName).toBe("claude");
  });

  it("serves dashboard HTML", async () => {
    const metrics = new MetricsCollector();
    server = new DashboardServer(0, metrics, () => undefined);
    if (!await safeStart(server)) return;

    const addr = (server as unknown as { server: { address: () => { port: number } } }).server.address();
    if (!addr || typeof addr === "string") return;

    const res = await fetch(`http://localhost:${addr.port}/`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Strada Brain Dashboard");
    expect(html).toContain("api/metrics");
  });

  it("returns 404 for unknown routes", async () => {
    const metrics = new MetricsCollector();
    server = new DashboardServer(0, metrics, () => undefined);
    if (!await safeStart(server)) return;

    const addr = (server as unknown as { server: { address: () => { port: number } } }).server.address();
    if (!addr || typeof addr === "string") return;

    const res = await fetch(`http://localhost:${addr.port}/unknown`);
    expect(res.status).toBe(404);
  });

  it("allows tokenless mutable dashboard requests from trusted origins", () => {
    const metrics = new MetricsCollector();
    server = new DashboardServer(0, metrics, () => undefined);

    const req = {
      headers: {
        origin: "http://localhost:3000",
      },
    } as unknown as import("node:http").IncomingMessage;
    const res = {
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as import("node:http").ServerResponse;

    const allowed = (server as unknown as {
      requireTrustedDashboardMutation: (
        req: import("node:http").IncomingMessage,
        res: import("node:http").ServerResponse,
      ) => boolean;
    }).requireTrustedDashboardMutation(req, res);

    expect(allowed).toBe(true);
    expect((res.writeHead as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("rejects tokenless mutable dashboard requests without trusted origin metadata", () => {
    const metrics = new MetricsCollector();
    server = new DashboardServer(0, metrics, () => undefined);

    const req = {
      headers: {},
    } as unknown as import("node:http").IncomingMessage;
    const res = {
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as import("node:http").ServerResponse;

    const allowed = (server as unknown as {
      requireTrustedDashboardMutation: (
        req: import("node:http").IncomingMessage,
        res: import("node:http").ServerResponse,
      ) => boolean;
    }).requireTrustedDashboardMutation(req, res);

    expect(allowed).toBe(false);
    expect((res.writeHead as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      403,
      { "Content-Type": "application/json" },
    );
  });

  it("returns trigger objects compatible with dashboard view contracts", async () => {
    const metrics = new MetricsCollector();
    server = new DashboardServer(0, metrics, () => undefined);
    server.setDaemonContext({
      registry: {
        getAll: vi.fn().mockReturnValue([
          {
            metadata: { name: "nightly-scan", type: "cron" },
            getState: vi.fn().mockReturnValue("active"),
            getNextRun: vi.fn().mockReturnValue(new Date("2026-03-17T19:00:00.000Z")),
          },
        ]),
      } as unknown as import("../daemon/trigger-registry.js").TriggerRegistry,
    });
    if (!await safeStart(server)) return;

    const addr = (server as unknown as { server: { address: () => { port: number } } }).server.address();
    if (!addr || typeof addr === "string") return;

    const res = await fetch(`http://localhost:${addr.port}/api/triggers`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual([
      expect.objectContaining({
        id: "nightly-scan",
        name: "nightly-scan",
        type: "cron",
        enabled: true,
        state: "active",
        fireCount: 0,
      }),
    ]);
  });

  it("returns provider payloads compatible with both settings page and model selector", async () => {
    const metrics = new MetricsCollector();
    server = new DashboardServer(0, metrics, () => undefined);
    server.registerExtendedServices({
      providerManager: {
        listAvailable: () => [
          {
            name: "kimi",
            label: "Kimi (Moonshot)",
            defaultModel: "kimi-for-coding",
            configured: true,
            models: ["kimi-for-coding"],
          },
        ],
        listAvailableWithModels: async () => [
          {
            name: "kimi",
            label: "Kimi (Moonshot)",
            defaultModel: "kimi-for-coding",
            configured: true,
            models: ["kimi-for-coding", "kimi-fast"],
            activeModel: "kimi-for-coding",
          },
        ],
        listExecutionCandidates: () => [
          {
            name: "kimi",
            label: "Kimi (Moonshot)",
            defaultModel: "kimi-for-coding",
            configured: true,
            models: ["kimi-for-coding"],
          },
        ],
        getActiveInfo: () => ({
          provider: "kimi",
          providerName: "kimi",
          model: "kimi-for-coding",
          isDefault: false,
          selectionMode: "strada-primary-worker",
          executionPolicyNote: "Strada remains the control plane. This selection sets the primary execution worker; planning, review, and synthesis may still route to other providers.",
        }),
        setPreference: async () => {},
      },
      embeddingStatusProvider: {
        getStatus: () => ({
          state: "active",
          ragEnabled: true,
          configuredProvider: "auto",
          resolvedProviderName: "Gemini:gemini-embedding-2-preview",
          resolutionSource: "auto-fallback:gemini",
          activeDimensions: 3072,
          verified: true,
          usingHashFallback: false,
        }),
      },
    });
    if (!await safeStart(server)) return;

    const addr = (server as unknown as { server: { address: () => { port: number } } }).server.address();
    if (!addr || typeof addr === "string") return;

    const availableRes = await fetch(`http://localhost:${addr.port}/api/providers/available`);
    expect(availableRes.status).toBe(200);
    const availableData = await availableRes.json();
    expect(availableData.providers[0]).toEqual(expect.objectContaining({
      name: "kimi",
      label: "Kimi (Moonshot)",
      defaultModel: "kimi-for-coding",
      configured: true,
      models: ["kimi-for-coding"],
    }));

    const activeRes = await fetch(`http://localhost:${addr.port}/api/providers/active?chatId=chat-1`);
    expect(activeRes.status).toBe(200);
    const activeData = await activeRes.json();
    expect(activeData.active).toEqual(expect.objectContaining({
      provider: "kimi",
      providerName: "kimi",
      model: "kimi-for-coding",
      isDefault: false,
      selectionMode: "strada-primary-worker",
      executionPolicyNote: expect.stringContaining("Strada remains the control plane"),
    }));
    expect(activeData.executionPool).toEqual([
      expect.objectContaining({
        name: "kimi",
        defaultModel: "kimi-for-coding",
      }),
    ]);

    const ragRes = await fetch(`http://localhost:${addr.port}/api/rag/status`);
    expect(ragRes.status).toBe(200);
    const ragData = await ragRes.json();
    expect(ragData.status).toEqual(expect.objectContaining({
      state: "active",
      configuredProvider: "auto",
      resolvedProviderName: "Gemini:gemini-embedding-2-preview",
      resolutionSource: "auto-fallback:gemini",
      activeDimensions: 3072,
      verified: true,
      usingHashFallback: false,
    }));
  });

  it("refreshes the shared provider catalog instead of creating a temporary service", async () => {
    const metrics = new MetricsCollector();
    server = new DashboardServer(0, metrics, () => undefined);
    const refreshCatalog = vi.fn().mockResolvedValue({
      modelsUpdated: 4,
      source: "litellm",
      errors: [],
    });

    server.registerExtendedServices({
      providerManager: {
        listAvailable: () => [],
        getActiveInfo: () => null,
        setPreference: async () => {},
        refreshCatalog,
      },
    });

    if (!await safeStart(server)) return;

    const addr = (server as unknown as { server: { address: () => { port: number } } }).server.address();
    if (!addr || typeof addr === "string") return;

    const res = await fetch(`http://localhost:${addr.port}/api/models/refresh`, {
      method: "POST",
      headers: {
        Origin: `http://localhost:${addr.port}`,
      },
    });

    expect(res.status).toBe(200);
    expect(refreshCatalog).toHaveBeenCalledTimes(1);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.result).toEqual(expect.objectContaining({
      modelsUpdated: 4,
      source: "litellm",
    }));
  });

  it("returns runtime execution traces alongside routing decisions", async () => {
    const metrics = new MetricsCollector();
    server = new DashboardServer(0, metrics, () => undefined);
    const getRecentDecisions = vi.fn(() => [{
      provider: "kimi",
      reason: "selected the planning-specialized worker",
      task: { type: "planning", complexity: "complex", criticality: "high" },
      timestamp: 123,
    }]);
    const getRecentExecutionTraces = vi.fn(() => [{
      provider: "gemini",
      model: "gemini-2.5-pro",
      role: "reviewer",
      phase: "consensus-review",
      source: "consensus-review",
      reason: "selected the review worker for cross-provider verification",
      task: { type: "code-review", complexity: "complex", criticality: "high" },
      timestamp: 456,
    }]);
    server.setProviderRouter({
      getPreset: () => "balanced",
      setPreset: () => {},
      getRecentDecisions,
      getRecentExecutionTraces,
    });

    if (!await safeStart(server)) return;

    const addr = (server as unknown as { server: { address: () => { port: number } } }).server.address();
    if (!addr || typeof addr === "string") return;

    const res = await fetch(`http://localhost:${addr.port}/api/agent-activity?chatId=chat-1&userId=user-1`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(getRecentDecisions).toHaveBeenCalledWith(20, "user-1");
    expect(getRecentExecutionTraces).toHaveBeenCalledWith(20, "user-1");
    expect(data.preset).toBe("balanced");
    expect(data.routing).toEqual([
      expect.objectContaining({
        provider: "kimi",
        task: expect.objectContaining({ type: "planning" }),
      }),
    ]);
    expect(data.execution).toEqual([
      expect.objectContaining({
        provider: "gemini",
        model: "gemini-2.5-pro",
        role: "reviewer",
        phase: "consensus-review",
        source: "consensus-review",
      }),
    ]);
  });

  it("resolves provider and autonomy settings against identity-aware keys when supplied", async () => {
    const metrics = new MetricsCollector();
    server = new DashboardServer(0, metrics, () => undefined);
    const getActiveInfo = vi.fn(() => ({
      provider: "kimi",
      providerName: "kimi",
      model: "accounts/fireworks/models/llama4-maverick-instruct-basic",
      isDefault: false,
      selectionMode: "strada-primary-worker",
      executionPolicyNote: "Strada remains the control plane.",
    }));
    const setPreference = vi.fn().mockResolvedValue(undefined);
    const isAutonomousMode = vi.fn().mockResolvedValue({ enabled: false });
    const setAutonomousMode = vi.fn().mockResolvedValue(undefined);

    server.registerExtendedServices({
      providerManager: {
        listAvailable: () => [
          {
            name: "kimi",
            label: "Kimi (Moonshot)",
            defaultModel: "kimi-for-coding",
            configured: true,
            models: ["kimi-for-coding"],
          },
        ],
        listExecutionCandidates: () => [
          {
            name: "kimi",
            label: "Kimi (Moonshot)",
            defaultModel: "kimi-for-coding",
            configured: true,
            models: ["kimi-for-coding"],
          },
        ],
        getActiveInfo,
        setPreference,
      },
      userProfileStore: {
        isAutonomousMode,
        setAutonomousMode,
      },
    });

    if (!await safeStart(server)) return;

    const addr = (server as unknown as { server: { address: () => { port: number } } }).server.address();
    if (!addr || typeof addr === "string") return;

    const activeRes = await fetch(
      `http://localhost:${addr.port}/api/providers/active?chatId=shared-chat&userId=user-42`,
    );
    expect(activeRes.status).toBe(200);
    expect(getActiveInfo).toHaveBeenCalledWith("user-42");
    const activeData = await activeRes.json();
    expect(activeData.executionPool).toEqual([
      expect.objectContaining({
        name: "kimi",
        defaultModel: "kimi-for-coding",
      }),
    ]);

    const switchRes = await fetch(`http://localhost:${addr.port}/api/providers/switch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: `http://localhost:${addr.port}`,
      },
      body: JSON.stringify({
        chatId: "shared-chat",
        userId: "user-42",
        provider: "kimi",
        model: "accounts/fireworks/models/llama4-maverick-instruct-basic",
      }),
    });
    expect(switchRes.status).toBe(200);
    expect(setPreference).toHaveBeenCalledWith(
      "user-42",
      "kimi",
      "accounts/fireworks/models/llama4-maverick-instruct-basic",
    );

    const autonomousRes = await fetch(
      `http://localhost:${addr.port}/api/user/autonomous?chatId=shared-chat&conversationId=thread-7`,
    );
    expect(autonomousRes.status).toBe(200);
    expect(isAutonomousMode).toHaveBeenCalledWith("thread-7");

    const setAutonomousRes = await fetch(`http://localhost:${addr.port}/api/user/autonomous`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: `http://localhost:${addr.port}`,
      },
      body: JSON.stringify({
        chatId: "shared-chat",
        conversationId: "thread-7",
        enabled: true,
        hours: 2,
      }),
    });
    expect(setAutonomousRes.status).toBe(200);
    expect(setAutonomousMode).toHaveBeenCalledWith("thread-7", true, expect.any(Number));
  });

  describe("/api/agent-metrics", () => {
    function getPort(srv: DashboardServer): number {
      const addr = (srv as unknown as { server: { address: () => { port: number } } }).server.address();
      if (!addr || typeof addr === "string") throw new Error("No address");
      return addr.port;
    }

    const MOCK_AGGREGATION: MetricsAggregation = {
      totalTasks: 42,
      successCount: 36,
      failureCount: 3,
      partialCount: 3,
      completionRate: 0.857,
      avgIterations: 4.2,
      avgToolCalls: 8.7,
      tasksWithInstincts: 26,
      instinctReusePct: 61.9,
      avgInstinctsPerInformedTask: 2.3,
    };

    function createMockMetricsStorage(agg?: MetricsAggregation): MetricsStorage {
      return {
        getAggregation: vi.fn().mockReturnValue(agg ?? MOCK_AGGREGATION),
        getTaskMetrics: vi.fn().mockReturnValue([]),
        getInstinctLeaderboard: vi.fn().mockReturnValue([]),
        initialize: vi.fn(),
        close: vi.fn(),
        recordTaskMetric: vi.fn(),
      } as unknown as MetricsStorage;
    }

    it("returns 200 with MetricsAggregation JSON when metricsStorage is registered", async () => {
      const metrics = new MetricsCollector();
      const mockStorage = createMockMetricsStorage();
      server = new DashboardServer(0, metrics, () => undefined);
      server.registerServices({ metricsStorage: mockStorage });
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/api/agent-metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");

      const data = await res.json();
      expect(data.totalTasks).toBe(42);
      expect(data.completionRate).toBe(0.857);
      expect(data.avgIterations).toBe(4.2);
    });

    it("returns 503 when metricsStorage is not registered", async () => {
      const metrics = new MetricsCollector();
      server = new DashboardServer(0, metrics, () => undefined);
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/api/agent-metrics`);
      expect(res.status).toBe(503);

      const data = await res.json();
      expect(data.error).toBe("Metrics not available");
    });

    it("passes session query param as sessionId filter", async () => {
      const metrics = new MetricsCollector();
      const mockStorage = createMockMetricsStorage();
      server = new DashboardServer(0, metrics, () => undefined);
      server.registerServices({ metricsStorage: mockStorage });
      if (!await safeStart(server)) return;

      const port = getPort(server);
      await fetch(`http://localhost:${port}/api/agent-metrics?session=abc`);

      expect(mockStorage.getAggregation).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "abc" }),
      );
    });

    it("passes type query param as taskType filter", async () => {
      const metrics = new MetricsCollector();
      const mockStorage = createMockMetricsStorage();
      server = new DashboardServer(0, metrics, () => undefined);
      server.registerServices({ metricsStorage: mockStorage });
      if (!await safeStart(server)) return;

      const port = getPort(server);
      await fetch(`http://localhost:${port}/api/agent-metrics?type=interactive`);

      expect(mockStorage.getAggregation).toHaveBeenCalledWith(
        expect.objectContaining({ taskType: "interactive" }),
      );
    });

    it("includes lifecycle field in response when learningStorage is registered", async () => {
      const metrics = new MetricsCollector();
      const mockMetricsStorage = createMockMetricsStorage();

      // Mock LearningStorage with lifecycle data
      const mockLearningStorage = {
        getInstincts: vi.fn()
          .mockReturnValueOnce([{ status: "permanent" }, { status: "permanent" }]) // permanent
          .mockReturnValueOnce([{ status: "active" }, { status: "active" }, { status: "active" }]) // active
          .mockReturnValueOnce([{ status: "proposed" }]) // proposed
          .mockReturnValueOnce([{ status: "deprecated" }]) // deprecated
          .mockReturnValueOnce([{ coolingStartedAt: Date.now() }]), // cooling (all instincts, filter for coolingStartedAt)
        getWeeklyCounters: vi.fn().mockReturnValue([
          { weekStart: Date.now(), eventType: "promoted", count: 2 },
          { weekStart: Date.now(), eventType: "deprecated", count: 1 },
          { weekStart: Date.now(), eventType: "cooling_started", count: 0 },
          { weekStart: Date.now(), eventType: "cooling_recovered", count: 0 },
        ]),
      };

      server = new DashboardServer(0, metrics, () => undefined);
      server.registerServices({
        metricsStorage: mockMetricsStorage,
        learningStorage: mockLearningStorage as unknown as import("../learning/storage/learning-storage.js").LearningStorage,
      });
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/api/agent-metrics`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.lifecycle).toBeDefined();
      expect(data.lifecycle.statusCounts).toBeDefined();
      expect(data.lifecycle.weeklyTrends).toBeDefined();
    });

    it("omits lifecycle field when learningStorage is not registered", async () => {
      const metrics = new MetricsCollector();
      const mockStorage = createMockMetricsStorage();
      server = new DashboardServer(0, metrics, () => undefined);
      server.registerServices({ metricsStorage: mockStorage });
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/api/agent-metrics`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.lifecycle).toBeUndefined();
    });

    it("parses since duration shorthand into timestamp filter", async () => {
      const metrics = new MetricsCollector();
      const mockStorage = createMockMetricsStorage();
      server = new DashboardServer(0, metrics, () => undefined);
      server.registerServices({ metricsStorage: mockStorage });
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const before = Date.now();
      await fetch(`http://localhost:${port}/api/agent-metrics?since=1d`);

      expect(mockStorage.getAggregation).toHaveBeenCalledTimes(1);
      const filter = (mockStorage.getAggregation as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // 1d = 86400000ms ago from ~now
      const expected = before - 86400000;
      expect(filter.since).toBeGreaterThanOrEqual(expected - 100);
      expect(filter.since).toBeLessThanOrEqual(before);
    });
  });

  describe("/api/daemon enrichment (18-03)", () => {
    function getPort(srv: DashboardServer): number {
      const addr = (srv as unknown as { server: { address: () => { port: number } } }).server.address();
      if (!addr || typeof addr === "string") throw new Error("No address");
      return addr.port;
    }

    function createMockIdentityManager() {
      return {
        getState: vi.fn().mockReturnValue({
          agentUuid: "uuid-1234-5678-abcd",
          agentName: "TestAgent",
          firstBootTs: 1700000000000,
          bootCount: 5,
          cumulativeUptimeMs: 3600000,
          lastActivityTs: 1700001000000,
          totalMessages: 42,
          totalTasks: 10,
          projectContext: "/test/project",
          cleanShutdown: true,
        }),
      };
    }

    function createMockHeartbeatLoop() {
      return {
        getDaemonStatus: vi.fn().mockReturnValue({
          running: true,
          intervalMs: 60000,
          budgetUsage: { usedUsd: 0.5, limitUsd: 10, pct: 5 },
        }),
        getCircuitBreaker: vi.fn().mockReturnValue(null),
      };
    }

    function createMockTriggerRegistry(triggers: Array<{
      name: string;
      type: string;
      state: string;
      nextRun: Date | null;
    }> = []) {
      const mockTriggers = triggers.map((t) => ({
        metadata: { name: t.name, description: `${t.name} trigger`, type: t.type },
        shouldFire: vi.fn().mockReturnValue(false),
        onFired: vi.fn(),
        getNextRun: vi.fn().mockReturnValue(t.nextRun),
        getState: vi.fn().mockReturnValue(t.state),
      }));
      return {
        getAll: vi.fn().mockReturnValue(mockTriggers),
      };
    }

    it("includes identity object when identityManager is set", async () => {
      const metrics = new MetricsCollector();
      server = new DashboardServer(0, metrics, () => undefined);

      const mockIdentity = createMockIdentityManager();
      const mockLoop = createMockHeartbeatLoop();
      const mockRegistry = createMockTriggerRegistry();

      server.setDaemonContext({
        heartbeatLoop: mockLoop as never,
        registry: mockRegistry as never,
        identityManager: mockIdentity as never,
      });
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/api/daemon`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.identity).toBeDefined();
      expect(data.identity.agentName).toBe("TestAgent");
      expect(data.identity.agentUuid).toBe("uuid-1234-5678-abcd");
      expect(data.identity.bootCount).toBe(5);
      expect(data.identity.cumulativeUptimeMs).toBe(3600000);
      expect(data.identity.lastActivityTs).toBe(1700001000000);
      expect(data.identity.firstBootTs).toBe(1700000000000);
      expect(data.identity.totalMessages).toBe(42);
      expect(data.identity.totalTasks).toBe(10);
      expect(data.identity.cleanShutdown).toBe(true);
    });

    it("includes capabilityManifest string when set", async () => {
      const metrics = new MetricsCollector();
      server = new DashboardServer(0, metrics, () => undefined);

      const mockLoop = createMockHeartbeatLoop();
      const mockRegistry = createMockTriggerRegistry();

      server.setDaemonContext({
        heartbeatLoop: mockLoop as never,
        registry: mockRegistry as never,
        capabilityManifest: "## Agent Capabilities\nGoal decomposition, learning, etc.",
      });
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/api/daemon`);
      const data = await res.json();

      expect(data.capabilityManifest).toBe("## Agent Capabilities\nGoal decomposition, learning, etc.");
    });

    it("includes startup notices when set", async () => {
      const metrics = new MetricsCollector();
      server = new DashboardServer(0, metrics, () => undefined);

      const mockLoop = createMockHeartbeatLoop();
      const mockRegistry = createMockTriggerRegistry();

      server.setDaemonContext({
        heartbeatLoop: mockLoop as never,
        registry: mockRegistry as never,
        startupNotices: [
          "Unavailable AI providers were skipped: gemini.",
          "Instinct embeddings disabled: learning continues with lexical matching only.",
        ],
      });
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/api/daemon`);
      const data = await res.json();

      expect(data.startupNotices).toEqual([
        "Unavailable AI providers were skipped: gemini.",
        "Instinct embeddings disabled: learning continues with lexical matching only.",
      ]);
    });

    it("includes triggerHistory from trigger registry metadata", async () => {
      const metrics = new MetricsCollector();
      server = new DashboardServer(0, metrics, () => undefined);

      const mockLoop = createMockHeartbeatLoop();
      const mockRegistry = createMockTriggerRegistry([
        { name: "daily-review", type: "cron", state: "active", nextRun: new Date("2026-03-11T00:00:00Z") },
        { name: "file-watcher", type: "file-watch", state: "active", nextRun: null },
      ]);

      server.setDaemonContext({
        heartbeatLoop: mockLoop as never,
        registry: mockRegistry as never,
      });
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/api/daemon`);
      const data = await res.json();

      expect(data.triggerHistory).toBeDefined();
      expect(Array.isArray(data.triggerHistory)).toBe(true);
      expect(data.triggerHistory.length).toBe(2);
      expect(data.triggerHistory[0].triggerName).toBe("daily-review");
      expect(data.triggerHistory[1].triggerName).toBe("file-watcher");
    });

    it("returns identity: null when identityManager is not set", async () => {
      const metrics = new MetricsCollector();
      server = new DashboardServer(0, metrics, () => undefined);

      const mockLoop = createMockHeartbeatLoop();
      const mockRegistry = createMockTriggerRegistry();

      server.setDaemonContext({
        heartbeatLoop: mockLoop as never,
        registry: mockRegistry as never,
      });
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/api/daemon`);
      const data = await res.json();

      expect(data.identity).toBeNull();
    });

    it("returns capabilityManifest: null when not set", async () => {
      const metrics = new MetricsCollector();
      server = new DashboardServer(0, metrics, () => undefined);

      const mockLoop = createMockHeartbeatLoop();
      const mockRegistry = createMockTriggerRegistry();

      server.setDaemonContext({
        heartbeatLoop: mockLoop as never,
        registry: mockRegistry as never,
      });
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/api/daemon`);
      const data = await res.json();

      expect(data.capabilityManifest).toBeNull();
      expect(data.startupNotices).toEqual([]);
    });

    it("dashboard HTML includes identity section and trigger history table", async () => {
      const metrics = new MetricsCollector();
      server = new DashboardServer(0, metrics, () => undefined);
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/`);
      const html = await res.text();

      expect(html).toContain("identity-panel");
      expect(html).toContain("trigger-history");
      expect(html).toContain("api/daemon");
    });
  });

  describe("/api/maintenance (21-03)", () => {
    function getPort(srv: DashboardServer): number {
      const addr = (srv as unknown as { server: { address: () => { port: number } } }).server.address();
      if (!addr || typeof addr === "string") throw new Error("No address");
      return addr.port;
    }

    it("returns default maintenance data when no memory manager registered", async () => {
      const metrics = new MetricsCollector();
      server = new DashboardServer(0, metrics, () => undefined);
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/api/maintenance`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.decay).toBeDefined();
      expect(data.decay.enabled).toBe(false);
      expect(data.pruning).toBeDefined();
      expect(data.pruning.retentionDays).toBe(30);
    });

    it("returns decay stats from memory manager when getDecayStats is available", async () => {
      const metrics = new MetricsCollector();
      server = new DashboardServer(0, metrics, () => undefined);

      const mockMemoryManager = {
        getHealth: vi.fn().mockReturnValue({ healthy: true, issues: [], storageUsagePercent: 10, indexHealth: "healthy" }),
        getDecayStats: vi.fn().mockReturnValue({
          enabled: true,
          tiers: {
            working: { entries: 42, avgScore: 0.65, atFloor: 3, lambda: 0.10 },
            ephemeral: { entries: 128, avgScore: 0.72, atFloor: 8, lambda: 0.05 },
            persistent: { entries: 512, avgScore: 0.84, atFloor: 12, lambda: 0.01 },
          },
          exemptDomains: ["instinct", "analysis-cache"],
          totalExempt: 15,
        }),
      };

      server.registerServices({ memoryManager: mockMemoryManager as any });
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/api/maintenance`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.decay.enabled).toBe(true);
      expect(data.decay.tiers.working.entries).toBe(42);
      expect(data.decay.tiers.working.avgScore).toBe(0.65);
      expect(data.decay.tiers.ephemeral.atFloor).toBe(8);
      expect(data.decay.tiers.persistent.lambda).toBe(0.01);
      expect(data.decay.exemptDomains).toEqual(["instinct", "analysis-cache"]);
      expect(data.decay.totalExempt).toBe(15);
    });

    it("dashboard HTML includes maintenance section", async () => {
      const metrics = new MetricsCollector();
      server = new DashboardServer(0, metrics, () => undefined);
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/`);
      const html = await res.text();

      expect(html).toContain("maintenance-panel");
      expect(html).toContain("Maintenance");
      expect(html).toContain("api/maintenance");
    });
  });

  describe("/api/chain-resilience (22-04)", () => {
    function getPort(srv: DashboardServer): number {
      const addr = (srv as unknown as { server: { address: () => { port: number } } }).server.address();
      if (!addr || typeof addr === "string") throw new Error("No address");
      return addr.port;
    }

    it("returns empty chains array when no learning storage registered", async () => {
      const metrics = new MetricsCollector();
      server = new DashboardServer(0, metrics, () => undefined);
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/api/chain-resilience`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.chains).toEqual([]);
      expect(data.config).toBeDefined();
      expect(data.config.rollbackEnabled).toBe(false);
    });

    it("returns chain list with V2 metadata from learning storage", async () => {
      const metrics = new MetricsCollector();
      server = new DashboardServer(0, metrics, () => undefined);

      const v2Action = JSON.stringify({
        version: 2,
        toolSequence: ["file_read", "file_write"],
        steps: [
          { stepId: "step_0", toolName: "file_read", dependsOn: [], reversible: true },
          { stepId: "step_1", toolName: "file_write", dependsOn: ["step_0"], reversible: true, compensatingAction: { toolName: "file_delete", inputMappings: { path: "path" } } },
        ],
        parameterMappings: [],
        isFullyReversible: true,
        successRate: 0.95,
        occurrences: 10,
      });

      const mockLearningStorage = {
        getInstincts: vi.fn().mockReturnValue([
          {
            id: "inst-1",
            name: "read_then_write",
            type: "tool_chain",
            status: "active",
            action: v2Action,
            updatedAt: 1710000000000,
          },
        ]),
      };

      server.registerServices({
        learningStorage: mockLearningStorage as any,
        chainResilienceConfig: {
          rollbackEnabled: true,
          parallelEnabled: true,
          maxParallelBranches: 4,
          compensationTimeoutMs: 30000,
        },
      });
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/api/chain-resilience`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.chains).toHaveLength(1);
      expect(data.chains[0].name).toBe("read_then_write");
      expect(data.chains[0].steps).toBe(2);
      expect(data.chains[0].rollbackCapable).toBe(true);
      expect(data.chains[0].parallelCapable).toBe(false); // sequential chain
      expect(data.chains[0].successRate).toBe(0.95);
      expect(data.chains[0].occurrences).toBe(10);
      expect(data.chains[0].lastRun).toBe(1710000000000);
      expect(data.config.rollbackEnabled).toBe(true);
      expect(data.config.parallelEnabled).toBe(true);
      expect(data.config.compensationTimeoutMs).toBe(30000);
    });

    it("returns V1 chains as non-reversible and sequential", async () => {
      const metrics = new MetricsCollector();
      server = new DashboardServer(0, metrics, () => undefined);

      const v1Action = JSON.stringify({
        toolSequence: ["file_read", "file_write"],
        parameterMappings: [],
        successRate: 0.80,
        occurrences: 5,
      });

      const mockLearningStorage = {
        getInstincts: vi.fn().mockReturnValue([
          {
            id: "inst-2",
            name: "legacy_chain",
            type: "tool_chain",
            status: "permanent",
            action: v1Action,
            updatedAt: 1710000000000,
          },
        ]),
      };

      server.registerServices({ learningStorage: mockLearningStorage as any });
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/api/chain-resilience`);
      const data = await res.json();

      expect(data.chains).toHaveLength(1);
      expect(data.chains[0].name).toBe("legacy_chain");
      expect(data.chains[0].rollbackCapable).toBe(false);
      expect(data.chains[0].parallelCapable).toBe(false);
      expect(data.chains[0].successRate).toBe(0.80);
    });

    it("detects parallel-capable chains with DAG branches", async () => {
      const metrics = new MetricsCollector();
      server = new DashboardServer(0, metrics, () => undefined);

      const v2Action = JSON.stringify({
        version: 2,
        toolSequence: ["fetch_data", "process_a", "process_b", "merge_results"],
        steps: [
          { stepId: "step_0", toolName: "fetch_data", dependsOn: [], reversible: false },
          { stepId: "step_1", toolName: "process_a", dependsOn: ["step_0"], reversible: false },
          { stepId: "step_2", toolName: "process_b", dependsOn: [], reversible: false },
          { stepId: "step_3", toolName: "merge_results", dependsOn: ["step_1", "step_2"], reversible: false },
        ],
        parameterMappings: [],
        isFullyReversible: false,
        successRate: 0.90,
        occurrences: 3,
      });

      const mockLearningStorage = {
        getInstincts: vi.fn().mockReturnValue([
          {
            id: "inst-3",
            name: "parallel_chain",
            type: "tool_chain",
            status: "active",
            action: v2Action,
            updatedAt: null,
          },
        ]),
      };

      server.registerServices({ learningStorage: mockLearningStorage as any });
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/api/chain-resilience`);
      const data = await res.json();

      expect(data.chains).toHaveLength(1);
      expect(data.chains[0].parallelCapable).toBe(true);
      expect(data.chains[0].lastRun).toBeNull();
    });

    it("dashboard HTML includes chain resilience section", async () => {
      const metrics = new MetricsCollector();
      server = new DashboardServer(0, metrics, () => undefined);
      if (!await safeStart(server)) return;

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/`);
      const html = await res.text();

      expect(html).toContain("chain-resilience-panel");
      expect(html).toContain("Chain Resilience");
      expect(html).toContain("api/chain-resilience");
    });
  });
});
