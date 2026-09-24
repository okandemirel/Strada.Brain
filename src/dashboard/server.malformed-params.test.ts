/**
 * CHN-1 — a route parameter that does not percent-decode is the request's
 * error, never the process's.
 *
 * `decodeURIComponent("%")` throws a URIError, and the dashboard's route
 * handlers run synchronously inside the HTTP server's request listener, so one
 * such request left the listener as an uncaughtException — which the daemon
 * answers with a full shutdown. Every parameterised route now answers 400, and
 * a throw from ANY handler is caught at the listener.
 */

import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardServer } from "./server.js";
import { MetricsCollector } from "./metrics.js";
import { VaultRegistry } from "../vault/vault-registry.js";
import { setInstanceIdentityStore } from "../channels/web/instance-authorization.js";
import type { IVault } from "../vault/vault.interface.js";

vi.mock("../utils/logger.js", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLogger: () => logger, getLoggerSafe: () => logger };
});

interface Reply {
  status: number;
  body: string;
}

/** A raw request: the path goes on the wire exactly as written. */
function send(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.setTimeout(5_000, () => req.destroy(new Error(`no answer for ${method} ${path}`)));
    req.end(method === "GET" || method === "DELETE" ? undefined : "{}");
  });
}

/** The owner of a two-identity instance, so owner-only routes reach their handler. */
const OWNER = { "x-strada-profile-id": "owner-profile", "x-strada-profile-token": "token-owner-profile" };

describe("DashboardServer: undecodable route parameters (CHN-1)", () => {
  let server: DashboardServer | null = null;
  let port = 0;
  const uncaught = vi.fn();

  beforeEach(async () => {
    process.on("uncaughtException", uncaught);
    setInstanceIdentityStore({
      verify: (profileId: string, token: string) => token === `token-${profileId}`,
      ownerProfileId: () => "owner-profile",
      has: (profileId: string) => profileId === "owner-profile" || profileId === "guest-profile",
      count: () => 2,
    });

    server = new DashboardServer(0, new MetricsCollector(), () => undefined);
    const registry = new VaultRegistry();
    // A real vault id, so the SECOND parameter of the two-parameter routes is reached.
    registry.register({ id: "v", rootPath: "/nonexistent-vault-root", dispose: async () => undefined } as unknown as IVault);
    server.registerVaultRegistry(registry);
    server.setCanvasStorage({} as never);
    server.registerExtendedServices({
      soulLoader: { deleteProfile: async () => true } as never,
    });
    await server.start();
    const addr = (server as unknown as { server: { address: () => { port: number } } }).server.address();
    port = addr.port;
  });

  afterEach(async () => {
    process.off("uncaughtException", uncaught);
    uncaught.mockReset();
    setInstanceIdentityStore(null);
    await server?.stop();
    server = null;
  });

  it.each([
    ["GET", "/api/monitor/task/%"],
    ["POST", "/api/monitor/task/%/approve"],
    ["POST", "/api/monitor/task/%/skip"],
    ["GET", "/api/canvas/project/%"],
    ["POST", "/api/canvas/%/export"],
    ["GET", "/api/canvas/%"],
    ["PUT", "/api/canvas/%"],
    ["DELETE", "/api/canvas/%"],
    ["POST", "/api/skills/%/enable"],
    ["POST", "/api/skills/%/disable"],
    ["DELETE", "/api/personality/profiles/%"],
    ["DELETE", "/api/vaults/%"],
    ["GET", "/api/vaults/%/canvas"],
    ["POST", "/api/vaults/%/regenerate-canvas"],
    ["GET", "/api/vaults/%/symbols/by-name?q=x"],
    ["GET", "/api/vaults/%/symbols/s/callers"],
    ["GET", "/api/vaults/v/symbols/%/callers"],
    ["POST", "/api/vaults/%/symbols/s/summarize"],
    ["POST", "/api/vaults/v/symbols/%/summarize"],
    ["GET", "/api/vaults/%/notes/n/backlinks"],
    ["GET", "/api/vaults/v/notes/%/backlinks"],
    ["GET", "/api/vaults/%/stats"],
    ["GET", "/api/vaults/%/tree"],
    ["GET", "/api/vaults/%/file"],
    ["GET", "/api/vaults/%/search"],
    ["POST", "/api/vaults/%/sync"],
    ["GET", "/api/workspace/history/%"],
  ])("%s %s answers 400 and the process keeps running", async (method, path) => {
    const headers: Record<string, string> = { ...OWNER, "Content-Type": "application/json" };
    if (method !== "GET") headers["Origin"] = `http://127.0.0.1:${port}`;

    const reply = await send(port, method, path, headers);

    expect(reply.status).toBe(400);
    expect(uncaught).not.toHaveBeenCalled();
    // Still serving.
    expect((await send(port, "GET", "/health")).status).toBe(200);
  });

  it("answers 500 — not an uncaughtException — when any handler throws", async () => {
    server!.registerExtendedServices({
      configSnapshot: () => { throw new Error("stored column is not JSON"); },
    });

    const reply = await send(port, "GET", "/api/config");

    expect(reply.status).toBe(500);
    expect(reply.body).not.toContain("stored column");
    expect(uncaught).not.toHaveBeenCalled();
    expect((await send(port, "GET", "/health")).status).toBe(200);
  });
});
