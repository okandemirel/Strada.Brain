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
    await server.start();

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
    await server.start();

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
    await server.start();

    const addr = (server as unknown as { server: { address: () => { port: number } } }).server.address();
    if (!addr || typeof addr === "string") return;

    const res = await fetch(`http://localhost:${addr.port}/`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Strata Brain Dashboard");
    expect(html).toContain("api/metrics");
  });

  it("returns 404 for unknown routes", async () => {
    const metrics = new MetricsCollector();
    server = new DashboardServer(0, metrics, () => undefined);
    await server.start();

    const addr = (server as unknown as { server: { address: () => { port: number } } }).server.address();
    if (!addr || typeof addr === "string") return;

    const res = await fetch(`http://localhost:${addr.port}/unknown`);
    expect(res.status).toBe(404);
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
      await server.start();

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
      await server.start();

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
      await server.start();

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
      await server.start();

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
      await server.start();

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
      await server.start();

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
      await server.start();

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
      await server.start();

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
      await server.start();

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/api/daemon`);
      const data = await res.json();

      expect(data.capabilityManifest).toBe("## Agent Capabilities\nGoal decomposition, learning, etc.");
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
      await server.start();

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
      await server.start();

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
      await server.start();

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/api/daemon`);
      const data = await res.json();

      expect(data.capabilityManifest).toBeNull();
    });

    it("dashboard HTML includes identity section and trigger history table", async () => {
      const metrics = new MetricsCollector();
      server = new DashboardServer(0, metrics, () => undefined);
      await server.start();

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
      await server.start();

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
      await server.start();

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
      await server.start();

      const port = getPort(server);
      const res = await fetch(`http://localhost:${port}/`);
      const html = await res.text();

      expect(html).toContain("maintenance-panel");
      expect(html).toContain("Maintenance");
      expect(html).toContain("api/maintenance");
    });
  });
});
