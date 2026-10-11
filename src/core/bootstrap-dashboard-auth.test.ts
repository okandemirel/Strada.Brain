/**
 * The dashboard's bearer token is in force from its first request
 * (core-bootstrap#2).
 *
 * initializeDashboard returns a server that is already listening. The token
 * used to arrive only through setDaemonContext, which bootstrap calls at the
 * end of the daemon stage (or after channel startup outside daemon mode), so
 * every /api route registered in between answered without it — reads open,
 * mutations behind nothing but a forgeable Origin header. A real
 * DashboardServer here, so the gate measured is the one that serves requests.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as winston from "winston";

const { serverLog, paths } = vi.hoisted(() => ({
  serverLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  paths: { credentialFile: "" },
}));

vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  return { ...actual, getLogger: () => serverLog, getLoggerSafe: () => serverLog };
});

// The operator credential goes to a temp dir, never this machine's config root.
vi.mock("./operator-credential.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./operator-credential.js")>();
  return { ...actual, operatorCredentialPath: () => paths.credentialFile };
});

import { initializeDashboard } from "./bootstrap-channels.js";
import { MetricsCollector } from "../dashboard/metrics.js";
import type { DashboardServer } from "../dashboard/server.js";
import type { Config } from "../config/config.js";

const TOKEN = "dashboard-secret";

let dir: string;
let dashboard: DashboardServer | undefined;

function makeLogger(): winston.Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as winston.Logger;
}

function makeConfig(authToken: string | undefined): Config {
  return {
    dashboard: { enabled: true, port: 0 },
    web: { port: 3000 },
    bindHost: "127.0.0.1",
    websocketDashboard: { authToken },
  } as unknown as Config;
}

/** Starts it the way bootstrap does; undefined when this sandbox refuses to listen. */
async function start(authToken: string | undefined): Promise<number | undefined> {
  const logger = makeLogger();
  dashboard = await initializeDashboard(makeConfig(authToken), new MetricsCollector(), undefined, logger);
  if (!dashboard) {
    expect(logger.warn).toHaveBeenCalledWith(
      "Dashboard failed to start",
      expect.objectContaining({ error: expect.stringMatching(/EPERM/) }),
    );
    return undefined;
  }
  const addr = (dashboard as unknown as { server: { address: () => { port: number } } }).server.address();
  return addr.port;
}

function warnedNoToken(): boolean {
  return serverLog.warn.mock.calls.some((call) => /WITHOUT an auth token/.test(String(call[0])));
}

describe("initializeDashboard applies the dashboard token before it listens", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "strada-dashboard-auth-"));
    paths.credentialFile = join(dir, "locks", "run.operator.json");
    serverLog.warn.mockClear();
  });

  afterEach(async () => {
    await dashboard?.stop();
    dashboard = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an unauthenticated /api read as soon as it returns", async () => {
    const port = await start(TOKEN);
    if (port === undefined) return;

    const anonymous = await fetch(`http://127.0.0.1:${port}/api/vaults`);
    expect(anonymous.status).toBe(401);

    const bearer = await fetch(`http://127.0.0.1:${port}/api/vaults`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(bearer.status).not.toBe(401);
  });

  it("refuses a mutation that carries only a forged loopback Origin", async () => {
    const port = await start(TOKEN);
    if (port === undefined) return;

    const res = await fetch(`http://127.0.0.1:${port}/api/vaults`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ rootPath: dir }),
    });
    expect(res.status).toBe(401);
  });

  it("does not log that it started without a token when one is configured", async () => {
    const port = await start(TOKEN);
    if (port === undefined) return;

    expect(warnedNoToken()).toBe(false);
  });

  it("still serves tokenless and says so when no token is configured", async () => {
    const port = await start(undefined);
    if (port === undefined) return;

    expect(warnedNoToken()).toBe(true);
    const anonymous = await fetch(`http://127.0.0.1:${port}/api/vaults`);
    expect(anonymous.status).not.toBe(401);
  });
});
