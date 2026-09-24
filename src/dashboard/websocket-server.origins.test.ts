/**
 * CHN-20: WEBSOCKET_DASHBOARD_ALLOWED_ORIGINS is a list of ORIGINS. A complete
 * origin is trusted on scheme + host + port, and a bare loopback name does not
 * re-trust every local port.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { WebSocketDashboardServer, splitAllowedOrigins } from "./websocket-server.js";
import { MetricsCollector } from "./metrics.js";

vi.mock("../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

let server: WebSocketDashboardServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

/** "open" or "refused", for a handshake carrying `origin(port)`; undefined on EPERM. */
async function handshake(allowedOrigins: string[], origin: (port: number) => string): Promise<string | undefined> {
  server = new WebSocketDashboardServer({ port: 0, metrics: new MetricsCollector(), getMemoryStats: () => undefined, allowedOrigins });
  try {
    await server.start();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return undefined;
    throw err;
  }
  const port = (server as unknown as { httpServer: { address: () => { port: number } } }).httpServer.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: origin(port) } });
  const outcome = await new Promise<string>((resolve) => {
    ws.on("open", () => resolve("open"));
    ws.on("unexpected-response", () => resolve("refused"));
    ws.on("error", () => resolve("refused"));
  });
  ws.terminate();
  return outcome;
}

describe("WebSocket dashboard allowedOrigins (CHN-20)", () => {
  it("accepts a complete origin listed in the setting", async () => {
    const outcome = await handshake(["https://dash.example.com"], () => "https://dash.example.com");
    if (outcome !== undefined) expect(outcome).toBe("open");
  });

  it("matches the listed origin on scheme and port as well", async () => {
    const outcome = await handshake(["https://dash.example.com"], () => "http://dash.example.com:8080");
    if (outcome !== undefined) expect(outcome).toBe("refused");
  });

  it("a bare localhost entry does not re-trust other loopback ports", async () => {
    const outcome = await handshake(["localhost"], (port) => `http://localhost:${port + 4}`);
    if (outcome !== undefined) expect(outcome).toBe("refused");
  });

  it("still honours a bare non-loopback host (existing deployments)", async () => {
    const outcome = await handshake(["myapp.local"], () => "http://myapp.local");
    if (outcome !== undefined) expect(outcome).toBe("open");
  });

  it("splits the setting into origins, hosts and ignored loopback names", () => {
    expect(splitAllowedOrigins([" https://a.example ", "b.example", "localhost", "localhost:5173", ""])).toEqual({
      trustedOrigins: ["https://a.example"],
      allowedHosts: ["b.example", "localhost:5173"],
      ignoredLoopback: ["localhost"],
    });
  });
});
