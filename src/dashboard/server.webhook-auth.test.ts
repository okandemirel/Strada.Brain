/**
 * CHN-5: with a dashboard token configured, POST /api/webhook still accepts
 * its own narrowly scoped credential (X-Webhook-Secret); the global bearer
 * gate must not answer for that one route, and only for that route.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardServer } from "./server.js";
import { MetricsCollector } from "./metrics.js";
import type { WebhookTrigger } from "../daemon/triggers/webhook-trigger.js";

vi.mock("../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

let server: DashboardServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

async function startServer(pushEvent: ReturnType<typeof vi.fn>): Promise<number | undefined> {
  server = new DashboardServer(0, new MetricsCollector(), () => undefined);
  const trigger = { metadata: { name: "ci" }, pushEvent } as unknown as WebhookTrigger;
  server.setDaemonContext({
    dashboardToken: "dashboard-token",
    webhookSecret: "hook-secret",
    webhookTriggers: new Map([["ci", trigger]]),
  });
  try {
    await server.start();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return undefined;
    throw err;
  }
  const addr = (server as unknown as { server: { address: () => { port: number } } }).server.address();
  return addr.port;
}

function post(port: number, path: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ action: "build" }),
  });
}

describe("POST /api/webhook with a dashboard token configured (CHN-5)", () => {
  it("accepts X-Webhook-Secret alone", async () => {
    const pushEvent = vi.fn();
    const port = await startServer(pushEvent);
    if (port === undefined) return;

    const res = await post(port, "/api/webhook", { "X-Webhook-Secret": "hook-secret" });
    expect(res.status).toBe(200);
    expect(pushEvent).toHaveBeenCalledWith("build", undefined, undefined);
  });

  it("still refuses a request with neither credential, or a wrong secret", async () => {
    const pushEvent = vi.fn();
    const port = await startServer(pushEvent);
    if (port === undefined) return;

    expect((await post(port, "/api/webhook", {})).status).toBe(401);
    expect((await post(port, "/api/webhook", { "X-Webhook-Secret": "wrong" })).status).toBe(401);
    expect(pushEvent).not.toHaveBeenCalled();
  });

  it("still accepts the dashboard bearer on the webhook route", async () => {
    const pushEvent = vi.fn();
    const port = await startServer(pushEvent);
    if (port === undefined) return;

    const res = await post(port, "/api/webhook", { Authorization: "Bearer dashboard-token" });
    expect(res.status).toBe(200);
  });

  it("does not extend the exemption to neighbouring paths", async () => {
    const port = await startServer(vi.fn());
    if (port === undefined) return;

    const res = await post(port, "/api/webhooks", { "X-Webhook-Secret": "hook-secret" });
    expect(res.status).toBe(401);
  });
});
