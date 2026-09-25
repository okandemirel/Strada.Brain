/**
 * COR-13: the CLI reads a running daemon over the dashboard API it shares
 * with the runtime. These pin the address and token it derives from config.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dashboardBaseUrl, resolveDaemonDashboardClient } from "./daemon-dashboard-client.js";

describe("dashboardBaseUrl", () => {
  it("connects to loopback when the dashboard binds a wildcard address", () => {
    expect(dashboardBaseUrl("0.0.0.0", 3100)).toBe("http://127.0.0.1:3100");
    expect(dashboardBaseUrl("::", 3100)).toBe("http://[::1]:3100");
  });

  it("uses a concrete bind address as is, bracketing IPv6", () => {
    expect(dashboardBaseUrl("127.0.0.1", 3100)).toBe("http://127.0.0.1:3100");
    expect(dashboardBaseUrl("::1", 3100)).toBe("http://[::1]:3100");
    expect(dashboardBaseUrl("strada.internal", 3200)).toBe("http://strada.internal:3200");
  });
});

describe("resolveDaemonDashboardClient", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function listen(): Promise<{ port: number; headers: Array<string | undefined> }> {
    const headers: Array<string | undefined> = [];
    server = createServer((req, res) => {
      headers.push(req.headers["authorization"]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ running: true }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    return { port: (server.address() as AddressInfo).port, headers };
  }

  it("refuses when the dashboard is disabled, rather than guessing a daemon state", () => {
    const resolution = resolveDaemonDashboardClient({
      bindHost: "127.0.0.1",
      dashboard: { enabled: false, port: 3100 },
      websocketDashboard: { enabled: false, port: 3101, authToken: undefined },
    });
    expect(resolution.kind).toBe("unavailable");
  });

  it("sends the configured dashboard token as a bearer, and none when unset", async () => {
    const { port, headers } = await listen();
    const withToken = resolveDaemonDashboardClient({
      bindHost: "0.0.0.0",
      dashboard: { enabled: true, port },
      websocketDashboard: { enabled: true, port: 1, authToken: "tok-123" },
    });
    const withoutToken = resolveDaemonDashboardClient({
      bindHost: "127.0.0.1",
      dashboard: { enabled: true, port },
      websocketDashboard: { enabled: false, port: 1, authToken: undefined },
    });
    if (withToken.kind !== "ok" || withoutToken.kind !== "ok") throw new Error("expected clients");

    await expect(withToken.client.getJson("/api/daemon")).resolves.toEqual({ kind: "ok", body: { running: true } });
    await expect(withoutToken.client.getJson("/api/daemon")).resolves.toMatchObject({ kind: "ok" });
    expect(headers).toEqual(["Bearer tok-123", undefined]);
  });
});
