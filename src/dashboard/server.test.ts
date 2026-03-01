import { describe, it, expect, vi, afterEach } from "vitest";
import { DashboardServer } from "./server.js";
import { MetricsCollector } from "./metrics.js";

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
});
