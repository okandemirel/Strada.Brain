/**
 * dashboard#1 — a portal served from a WEB_TRUSTED_ORIGINS origin could not
 * write anything.
 *
 * The documented topologies (the Vite dev proxy on :5173, an HTTPS reverse
 * proxy such as the docker-compose nginx) keep the browser's Origin, which the
 * portal accepts (round 10 #19). The portal then dropped that header before
 * proxying, because the dashboard's gate trusts only loopback ports — and with
 * no dashboard token configured (the default) the dashboard refused the
 * header-less mutation: 403 "Trusted same-origin request required" for every
 * canvas save, change-review decision, personality switch and toggle.
 *
 * The channel tests that covered this stubbed fetch to 200, so this file runs
 * the real portal in front of the real dashboard, the way bootstrap wires them
 * (the dashboard trusts the portal's port, nothing else, no token). It also
 * checks the other direction: trusting a proxy origin must not let any other
 * page through either hop.
 */

import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebChannel } from "./channel.js";
import { DashboardServer } from "../../dashboard/server.js";
import { MetricsCollector } from "../../dashboard/metrics.js";
import { setInstanceIdentityStore } from "./instance-authorization.js";

vi.mock("../../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

const VITE = "http://localhost:5173";
const REVERSE_PROXY = "https://portal.example";

interface Reply {
  status: number;
  body: string;
}

function send(port: number, method: string, path: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.setTimeout(5_000, () => req.destroy(new Error(`no answer for ${method} ${path}`)));
    req.end(method === "GET" ? undefined : "{}");
  });
}

/** A loopback port nothing is listening on right now. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("portal behind a trusted proxy origin → real dashboard (dashboard#1)", () => {
  let dashboard: DashboardServer;
  let channel: WebChannel;
  let portalPort = 0;
  let dashboardPort = 0;

  beforeEach(async () => {
    // A single-user instance: nothing about identities decides these requests.
    setInstanceIdentityStore({
      verify: () => false,
      ownerProfileId: () => undefined,
      has: () => false,
      count: () => 0,
    });
    portalPort = await freePort();
    // As bootstrap-channels builds it: the portal's port is the one foreign
    // loopback port the dashboard trusts, and no WEBSOCKET_DASHBOARD_AUTH_TOKEN.
    dashboard = new DashboardServer(0, new MetricsCollector(), () => undefined, () => false, [portalPort], "127.0.0.1", []);
    await dashboard.start();
    dashboardPort = ((dashboard as unknown as { server: { address(): AddressInfo } }).server.address()).port;
    channel = new WebChannel(portalPort, dashboardPort, {
      bindHost: "127.0.0.1",
      allowedHosts: [],
      trustedOrigins: [VITE, REVERSE_PROXY],
    });
    await channel.connect();
  });

  afterEach(async () => {
    await channel.disconnect();
    await dashboard.stop();
    setInstanceIdentityStore(null);
  });

  const mutation = (port: number, headers: Record<string, string>) =>
    send(port, "POST", "/api/monitor/export", { "Content-Type": "application/json", ...headers });

  it.each([VITE, REVERSE_PROXY])("a mutation from the trusted origin %s reaches the dashboard's handler", async (origin) => {
    const reply = await mutation(portalPort, { Origin: origin });

    expect(reply.body).not.toContain("Trusted same-origin request required");
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toHaveProperty("markdown");
  });

  it("a mutation whose only header is the trusted origin's Referer reaches it too", async () => {
    const reply = await mutation(portalPort, { Referer: `${VITE}/monitor` });

    expect(reply.status).toBe(200);
  });

  it("still serves the portal's own page, as before", async () => {
    const reply = await mutation(portalPort, { Origin: `http://127.0.0.1:${portalPort}` });

    expect(reply.status).toBe(200);
  });

  // ── The other direction: what trusting a proxy origin must NOT open up ──

  it.each([
    "http://localhost:9999",   // another process on this machine
    "http://localhost:5174",   // the next Vite instance, not the configured one
    "https://evil.example",    // a foreign site
    "null",                    // a sandboxed frame
  ])("the portal still refuses a mutation from %s", async (origin) => {
    const reply = await mutation(portalPort, { Origin: origin });

    expect(reply.status).toBe(403);
  });

  it("the portal does not vouch for a header-less mutation (no token is configured)", async () => {
    const reply = await mutation(portalPort, {});

    expect(reply.status).toBe(403);
  });

  it("the dashboard itself still trusts no proxy origin: only the portal's vouching gets through", async () => {
    const direct = await mutation(dashboardPort, { Origin: REVERSE_PROXY });
    expect(direct.status).toBe(403);

    const headerless = await mutation(dashboardPort, {});
    expect(headerless.status).toBe(403);
    expect(headerless.body).toContain("Trusted same-origin request required");
  });
});
