/**
 * COR-17: a WS-dashboard or Prometheus start failure aborts boot, and the
 * listeners started before it were not yet on the teardown stack, so they
 * stayed bound.
 */
import { describe, expect, it, vi } from "vitest";

const { wsStop, promStart } = vi.hoisted(() => ({
  wsStop: vi.fn(),
  promStart: vi.fn(async () => { throw new Error("listen EADDRINUSE: 9090"); }),
}));

vi.mock("../../dashboard/websocket-server.js", () => ({
  WebSocketDashboardServer: vi.fn().mockImplementation(function () {
    return { start: vi.fn(async () => {}), stop: wsStop };
  }),
}));
vi.mock("../../dashboard/prometheus.js", () => ({
  PrometheusMetrics: vi.fn().mockImplementation(function () {
    return { start: promStart, stop: vi.fn() };
  }),
}));

import { initializeOpsMonitoringStage } from "./stage-knowledge.js";
import type { Config } from "../../config/config.js";

describe("initializeOpsMonitoringStage (COR-17)", () => {
  it("stops the listeners it already started when a later one fails to start", async () => {
    const dashboardStop = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const config = {
      bindHost: "127.0.0.1",
      websocketDashboard: { enabled: true, port: 3101, authToken: "t", allowedOrigins: [] },
      prometheus: { enabled: true, port: 9090 },
      memory: { dbPath: "/nonexistent" },
    } as unknown as Config;

    await expect(initializeOpsMonitoringStage(
      { config, logger: logger as never, metrics: {} as never },
      {
        initializeDashboard: async () => ({ stop: dashboardStop }) as never,
        initializeRateLimiter: () => undefined,
      },
    )).rejects.toThrow(/EADDRINUSE/);

    expect(wsStop).toHaveBeenCalledTimes(1);
    expect(dashboardStop).toHaveBeenCalledTimes(1);
  });
});
