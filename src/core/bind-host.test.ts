/**
 * BIND_HOST (14F2 / D71).
 *
 * The web channel, the dashboard, the WebSocket dashboard and the Prometheus
 * exporter all passed the literal "127.0.0.1" to `listen()`. Inside a
 * container that address belongs to the container's own loopback, so
 * `-p 3100:3100` publishes a port nothing answers on — the listener is
 * unreachable by construction and no configuration could change it.
 *
 * These tests bind the real servers and read back the bound address, so they
 * fail on a hardcoded loopback rather than on a string match.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_BIND_HOST, resolveBindHost } from "./bind-host.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/** Can this environment bind a wildcard socket at all? Sandboxes sometimes cannot. */
const wildcardBindable = await new Promise<boolean>((resolve) => {
  const probe = createServer(() => {});
  probe.once("error", () => resolve(false));
  probe.listen(0, "0.0.0.0", () => probe.close(() => resolve(true)));
});

function boundAddress(server: { address(): AddressInfo | string | null }): string {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server is not bound");
  return addr.address;
}

describe("resolveBindHost", () => {
  const original = process.env["BIND_HOST"];
  afterEach(() => {
    if (original === undefined) delete process.env["BIND_HOST"];
    else process.env["BIND_HOST"] = original;
  });

  it("defaults to loopback so a local run is unchanged", () => {
    expect(DEFAULT_BIND_HOST).toBe("127.0.0.1");
    expect(resolveBindHost({})).toBe("127.0.0.1");
  });

  it("returns a configured wildcard address", () => {
    expect(resolveBindHost({ BIND_HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(resolveBindHost({ BIND_HOST: "::" })).toBe("::");
    expect(resolveBindHost({ BIND_HOST: " 10.1.2.3 " })).toBe("10.1.2.3");
  });

  it("rejects a value that is not a host (validated, not trusted)", () => {
    expect(() => resolveBindHost({ BIND_HOST: "http://0.0.0.0:3100" })).toThrow(/BIND_HOST/);
    expect(() => resolveBindHost({ BIND_HOST: "0.0.0.0 && rm -rf /" })).toThrow(/BIND_HOST/);
    expect(() => resolveBindHost({ BIND_HOST: "" })).toThrow(/BIND_HOST/);
  });

  it("is what the config exposes", async () => {
    const { loadConfig } = await import("../config/config.js");
    const config = loadConfig({
      UNITY_PROJECT_PATH: process.cwd(),
      ANTHROPIC_API_KEY: "sk-ant-test",
      BIND_HOST: "0.0.0.0",
    } as never);
    expect(config.bindHost).toBe("0.0.0.0");
  });
});

describe.skipIf(!wildcardBindable)("listeners honour BIND_HOST", () => {
  const original = process.env["BIND_HOST"];
  const stoppers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (stoppers.length > 0) await stoppers.pop()!();
    if (original === undefined) delete process.env["BIND_HOST"];
    else process.env["BIND_HOST"] = original;
  });

  it("the dashboard server binds the configured host", async () => {
    process.env["BIND_HOST"] = "0.0.0.0";
    const { DashboardServer } = await import("../dashboard/server.js");
    const { MetricsCollector } = await import("../dashboard/metrics.js");
    const server = new DashboardServer(0, new MetricsCollector(), () => undefined);
    await server.start();
    stoppers.push(() => server.stop());
    expect(boundAddress((server as unknown as { server: AddressInfoHolder }).server)).toBe("0.0.0.0");
  });

  it("the WebSocket dashboard binds the configured host", async () => {
    process.env["BIND_HOST"] = "0.0.0.0";
    const { WebSocketDashboardServer } = await import("../dashboard/websocket-server.js");
    const { MetricsCollector } = await import("../dashboard/metrics.js");
    const server = new WebSocketDashboardServer({
      port: 0,
      metrics: new MetricsCollector(),
      getMemoryStats: () => undefined,
    });
    await server.start();
    stoppers.push(() => server.stop());
    expect(boundAddress((server as unknown as { httpServer: AddressInfoHolder }).httpServer)).toBe("0.0.0.0");
  });

  it("the Prometheus exporter binds the configured host", async () => {
    process.env["BIND_HOST"] = "0.0.0.0";
    const { PrometheusMetrics } = await import("../dashboard/prometheus.js");
    const { MetricsCollector } = await import("../dashboard/metrics.js");
    const { register } = await import("prom-client");
    register.clear();
    const exporter = new PrometheusMetrics(0, new MetricsCollector(), () => undefined);
    await exporter.start();
    stoppers.push(async () => {
      await exporter.stop();
      register.clear();
    });
    expect(boundAddress((exporter as unknown as { server: AddressInfoHolder }).server)).toBe("0.0.0.0");
  });

  it("the web channel binds the configured host", async () => {
    process.env["BIND_HOST"] = "0.0.0.0";
    const { WebChannel } = await import("../channels/web/channel.js");
    const channel = new WebChannel(0, 0, {});
    await channel.connect();
    stoppers.push(() => channel.disconnect());
    expect(boundAddress((channel as unknown as { server: AddressInfoHolder }).server)).toBe("0.0.0.0");
  });

  it("still binds loopback when BIND_HOST is unset", async () => {
    delete process.env["BIND_HOST"];
    const { DashboardServer } = await import("../dashboard/server.js");
    const { MetricsCollector } = await import("../dashboard/metrics.js");
    const server = new DashboardServer(0, new MetricsCollector(), () => undefined);
    await server.start();
    stoppers.push(() => server.stop());
    expect(boundAddress((server as unknown as { server: AddressInfoHolder }).server)).toBe("127.0.0.1");
  });
});

interface AddressInfoHolder {
  address(): AddressInfo | string | null;
}
