/**
 * COR-13: the CLI reads a running daemon over the dashboard API it shares
 * with the runtime. These pin the address and token it derives from config.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardBaseUrl, resolveDaemonDashboardClient, resolveDaemonOperatorClient } from "./daemon-dashboard-client.js";
import { publishOperatorCredential } from "./operator-credential.js";

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

describe("the local operator client (COR-13)", () => {
  let server: Server | undefined;
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "strada-opclient-"));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const config = (authToken?: string, enabled = true) => ({
    dashboard: { enabled, port: 3100 },
    websocketDashboard: { enabled: false, port: 3101, authToken },
  });

  async function listen(): Promise<{ baseUrl: string; seen: Array<{ url?: string; headers: Record<string, unknown>; body: string }> }> {
    const seen: Array<{ url?: string; headers: Record<string, unknown>; body: string }> = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        seen.push({ url: req.url, headers: req.headers, body });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "reset" }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }

  it("posts JSON to the URL the credential names, with the token in its header only, and the dashboard bearer when set", async () => {
    const { baseUrl, seen } = await listen();
    const file = join(dir, "k.operator.json");
    const token = "t".repeat(43);
    await publishOperatorCredential(file, { baseUrl, pid: 1234, token });

    const resolution = await resolveDaemonOperatorClient(file, config("bearer-9"));
    if (resolution.kind !== "ok") throw new Error(resolution.message);
    await expect(resolution.client.postJson("/api/daemon/budget/reset", {})).resolves.toEqual({ kind: "ok", body: { status: "reset" } });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/api/daemon/budget/reset");
    expect(seen[0]!.body).toBe("{}");
    expect(seen[0]!.headers).toMatchObject({
      "content-type": "application/json",
      "x-strada-operator-token": token,
      authorization: "Bearer bearer-9",
    });
  });

  it("keeps a refusal's JSON body, so a 409 or 404 can say more than its error line", async () => {
    server = createServer((_req, res) => {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "A memory:consolidate job is already running: j-1", jobId: "j-1" }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const file = join(dir, "k.operator.json");
    await publishOperatorCredential(file, { baseUrl, pid: 1, token: "t".repeat(43) });
    const resolution = await resolveDaemonOperatorClient(file, config());
    if (resolution.kind !== "ok") throw new Error(resolution.message);

    await expect(resolution.client.postJson("/api/consolidation/run", {})).resolves.toEqual({
      kind: "refused",
      status: 409,
      message: `the dashboard at ${baseUrl} refused POST /api/consolidation/run: A memory:consolidate job is already running: j-1`,
      body: { error: "A memory:consolidate job is already running: j-1", jobId: "j-1" },
    });
  });

  it("reads a job from the same runtime through the read gates: the bearer, never the operator token", async () => {
    const { baseUrl, seen } = await listen();
    const file = join(dir, "k.operator.json");
    await publishOperatorCredential(file, { baseUrl, pid: 1, token: "t".repeat(43) });
    const resolution = await resolveDaemonOperatorClient(file, config("bearer-9"));
    if (resolution.kind !== "ok") throw new Error(resolution.message);

    await expect(resolution.client.getJson("/api/daemon/jobs/j-1")).resolves.toMatchObject({ kind: "ok" });
    expect(seen[0]!.url).toBe("/api/daemon/jobs/j-1");
    expect(seen[0]!.headers["authorization"]).toBe("Bearer bearer-9");
    expect(seen[0]!.headers).not.toHaveProperty("x-strada-operator-token");
  });

  it("names the file and what its absence can mean", async () => {
    const file = join(dir, "missing.operator.json");
    const resolution = await resolveDaemonOperatorClient(file, config());
    expect(resolution).toEqual({
      kind: "unavailable",
      message: expect.stringContaining(`at ${file}: Strada is not running from this install, runs as another OS user, or uses a different config root`),
    });

    const disabled = await resolveDaemonOperatorClient(file, config(undefined, false));
    expect(disabled.kind === "unavailable" && disabled.message).toContain("DASHBOARD_ENABLED");
  });

  it("refuses a credential it cannot read or use", async () => {
    const unreadable = await resolveDaemonOperatorClient(dir, config());
    expect(unreadable.kind === "unavailable" && unreadable.message).toContain(`cannot read the operator credential at ${dir}`);

    const garbage = join(dir, "garbage.json");
    writeFileSync(garbage, "not json");
    const invalid = await resolveDaemonOperatorClient(garbage, config());
    expect(invalid.kind === "unavailable" && invalid.message).toContain("restarting Strada rewrites it");
  });
});
