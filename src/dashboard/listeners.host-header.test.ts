/**
 * CHN-2 — every dashboard-side listener answers only for Host names it can
 * vouch for: the dashboard HTTP server, the WebSocket dashboard (page and
 * handshake) and the Prometheus exporter. Loopback binding keeps other
 * machines out, not other origins; the Host header is what still names the
 * page's own hostname.
 */

import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { DashboardServer } from "./server.js";
import { WebSocketDashboardServer } from "./websocket-server.js";
import { PrometheusMetrics } from "./prometheus.js";
import { MetricsCollector } from "./metrics.js";

vi.mock("../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

function send(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function wsAccepted(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { host } });
    ws.on("open", () => { ws.terminate(); resolve(true); });
    ws.on("unexpected-response", () => resolve(false));
    ws.on("error", () => resolve(false));
  });
}

function boundPort(server: unknown, field: string): number {
  const inner = (server as Record<string, { address: () => { port: number } }>)[field]!;
  return inner.address().port;
}

describe("DashboardServer Host validation (CHN-2)", () => {
  let server: DashboardServer | null = null;

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server?.stop();
    server = null;
  });

  it("refuses GET /api/config for a foreign Host and serves it for loopback", async () => {
    server = new DashboardServer(0, new MetricsCollector(), () => undefined, () => false, [], "127.0.0.1", []);
    await server.start();
    const port = boundPort(server, "server");

    const foreign = await send(port, "/api/config", `evil.test:${port}`);
    expect(foreign.status).toBe(403);
    expect(foreign.body).toContain("HTTP_ALLOWED_HOSTS");
    expect((await send(port, "/", `evil.test:${port}`)).status).toBe(403);

    expect((await send(port, "/api/config", `localhost:${port}`)).status).toBe(200);
    expect((await send(port, "/api/config", `127.0.0.1:${port}`)).status).toBe(200);
  });

  it("serves the hosts named by HTTP_ALLOWED_HOSTS (a container behind a proxy)", async () => {
    vi.stubEnv("HTTP_ALLOWED_HOSTS", "strada.example,strada-brain");
    server = new DashboardServer(0, new MetricsCollector(), () => undefined, () => false, [], "127.0.0.1");
    await server.start();
    const port = boundPort(server, "server");

    expect((await send(port, "/api/config", "strada.example")).status).toBe(200);
    expect((await send(port, "/health", "strada-brain:3100")).status).toBe(200);
    expect((await send(port, "/api/config", "evil.example")).status).toBe(403);
  });
});

describe("WebSocketDashboardServer Host validation (CHN-2)", () => {
  let server: WebSocketDashboardServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  async function start(extra: Partial<ConstructorParameters<typeof WebSocketDashboardServer>[0]> = {}): Promise<number> {
    server = new WebSocketDashboardServer({
      port: 0,
      bindHost: "127.0.0.1",
      metrics: new MetricsCollector(),
      getMemoryStats: () => undefined,
      allowedHosts: [],
      ...extra,
    });
    await server.start();
    return boundPort(server, "httpServer");
  }

  it("refuses the page and the handshake for a foreign Host", async () => {
    const port = await start();

    expect((await send(port, "/", `evil.test:${port}`)).status).toBe(403);
    expect(await wsAccepted(port, `evil.test:${port}`)).toBe(false);

    expect((await send(port, "/", `localhost:${port}`)).status).toBe(200);
    expect(await wsAccepted(port, `127.0.0.1:${port}`)).toBe(true);
  });

  it("serves a host the operator's allowedOrigins name", async () => {
    const port = await start({ allowedOrigins: ["dash.example"] });
    expect((await send(port, "/", "dash.example")).status).toBe(200);
  });
});

describe("PrometheusMetrics Host validation (CHN-2)", () => {
  let prometheus: PrometheusMetrics | null = null;

  afterEach(async () => {
    await prometheus?.stop();
    prometheus = null;
  });

  it("refuses /metrics for a foreign Host and serves the configured scrape host", async () => {
    prometheus = new PrometheusMetrics(0, new MetricsCollector(), () => undefined, undefined, "127.0.0.1", ["strada-brain"]);
    await prometheus.start();
    const port = boundPort(prometheus, "server");

    expect((await send(port, "/metrics", `evil.test:${port}`)).status).toBe(403);
    expect((await send(port, "/metrics", "strada-brain:9090")).status).toBe(200);
    expect((await send(port, "/metrics", `127.0.0.1:${port}`)).status).toBe(200);
  });
});
