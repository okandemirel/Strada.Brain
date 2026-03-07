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
});
