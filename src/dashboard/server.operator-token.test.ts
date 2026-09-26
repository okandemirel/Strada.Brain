/**
 * COR-13: the local operator credential. `strada daemon trigger|reset|budget
 * reset|…` from a shell POSTs with the per-run token the dashboard writes to a
 * 0600 file under the config root. These pin what that token opens (the
 * allowlisted CLI routes, past the bearer, same-origin and owner gates) and
 * what it does not (any other route, a query string, a browser page).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardServer } from "./server.js";
import { MetricsCollector } from "./metrics.js";
import { LOCAL_OPERATOR_ROUTES } from "./server-daemon-control-routes.js";
import { ownerOnlyProxySurface } from "../channels/web/instance-access.js";
import { setInstanceIdentityStore } from "../channels/web/instance-authorization.js";
import { OPERATOR_TOKEN_HEADER, readOperatorCredential } from "../core/operator-credential.js";
import type { DaemonContext } from "../daemon/daemon-cli.js";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  return { ...actual, getLogger: () => logger, getLoggerSafe: () => logger };
});

const AGENT = "123e4567-e89b-42d3-a456-426614174000";

/** Owner first, then a guest: a genuinely shared instance. */
function identities() {
  const issued = ["owner-profile", "guest-profile"];
  return {
    verify: (profileId: string, token: string) => issued.includes(profileId) && token === `token-${profileId}`,
    ownerProfileId: () => "owner-profile",
    has: (profileId: string) => issued.includes(profileId),
    count: () => issued.length,
  };
}
const as = (profileId: string): Record<string, string> => ({
  "x-strada-profile-id": profileId,
  "x-strada-profile-token": `token-${profileId}`,
});

function fakeDaemon() {
  const fireNow = vi.fn((name: string) => (name === "nightly" ? { status: "submitted", taskId: "task_1" } : { status: "not_found" }));
  const breaker = {
    reset: vi.fn(),
    getState: vi.fn(() => "CLOSED"),
    serialize: vi.fn(() => ({ state: "CLOSED", consecutiveFailures: 0, lastFailureTime: 0, cooldownMs: 1000 })),
  };
  const ctx = {
    heartbeatLoop: {
      getCircuitBreaker: vi.fn((name: string) => (name === "nightly" ? breaker : undefined)),
      fireNow,
    },
    registry: { getByName: vi.fn() },
    budgetTracker: { resetBudget: vi.fn() },
    approvalQueue: { getAuditLog: vi.fn(() => [{ id: 1, toolName: "shell_exec", decision: "approved", timestamp: 1 }]) },
    storage: { upsertCircuitState: vi.fn() },
    config: {},
    digestReporter: { sendDigest: vi.fn(async () => "sent"), previewDigest: vi.fn(() => "**preview**") },
    notificationRouter: { notify: vi.fn(async () => undefined), getHistory: vi.fn(() => []) },
    agentManager: { stopAgent: vi.fn(async () => undefined), startAgent: vi.fn(async () => undefined), setBudgetCap: vi.fn() },
    tierRouter: { setOverride: vi.fn() },
    consolidationEngine: {
      getStats: vi.fn(),
      preview: vi.fn(async () => ({ clusters: [], estimatedCostPerCluster: 0, totalEstimatedCost: 0 })),
      runCycle: vi.fn(async () => ({ status: "completed", processed: 2, remaining: 0, clustersFound: 2, costUsd: 0.01 })),
      undo: vi.fn(async (logId: string) => {
        if (logId !== "log-1") throw new Error(`Consolidation log entry not found: ${logId}`);
      }),
    },
    readinessChecker: {
      checkReadiness: vi.fn(async () => ({ ready: true, testPassed: true, gitClean: true, branchMatch: true, timestamp: 1, cached: false })),
    },
    deployTrigger: { triggerReadinessCheck: vi.fn(async () => ({})), onApprovalDecided: vi.fn() },
  };
  return { ctx, fireNow, breaker };
}

/**
 * Every allowlisted route with a body it accepts, the spy it must reach, and
 * its success status (the two long operations answer 202: they start a job).
 */
function operatorCalls(daemon: ReturnType<typeof fakeDaemon>) {
  const { ctx } = daemon;
  return [
    { path: "/api/daemon/trigger", body: { name: "nightly" }, spy: daemon.fireNow },
    { path: "/api/daemon/circuit/reset", body: { name: "nightly" }, spy: daemon.breaker.reset },
    { path: "/api/daemon/budget/reset", body: {}, spy: ctx.budgetTracker.resetBudget },
    { path: "/api/daemon/digest/send", body: {}, spy: ctx.digestReporter.sendDigest },
    { path: "/api/daemon/notify", body: { level: "high", message: "hi" }, spy: ctx.notificationRouter.notify },
    { path: `/api/agents/${AGENT}/stop`, body: { force: true }, spy: ctx.agentManager.stopAgent },
    { path: `/api/agents/${AGENT}/start`, body: {}, spy: ctx.agentManager.startAgent },
    { path: `/api/agents/${AGENT}/budget`, body: { usd: 2.5 }, spy: ctx.agentManager.setBudgetCap },
    { path: "/api/delegations/tier", body: { type: "code_review", tier: "cheap" }, spy: ctx.tierRouter.setOverride },
    { path: "/api/consolidation/run", body: {}, spy: ctx.consolidationEngine.runCycle, status: 202 },
    { path: "/api/consolidation/undo", body: { logId: "log-1" }, spy: ctx.consolidationEngine.undo },
    { path: "/api/deployment/check", body: {}, spy: ctx.readinessChecker.checkReadiness, status: 202 },
  ].map((call) => ({ status: 200, ...call }));
}

let server: DashboardServer | null = null;
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "strada-operator-"));
  setInstanceIdentityStore(identities());
});

afterEach(async () => {
  await server?.stop();
  server = null;
  setInstanceIdentityStore(null);
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

interface Started {
  port: number;
  token: string;
  file: string;
  daemon: ReturnType<typeof fakeDaemon>;
}

async function start(options: { dashboardToken?: string } = {}): Promise<Started | null> {
  const file = join(dir, ".strada", "locks", "abc.operator.json");
  const daemon = fakeDaemon();
  server = new DashboardServer(0, new MetricsCollector(), () => undefined, () => false, [], "127.0.0.1", [], file);
  server.setDaemonContext({
    cliContext: daemon.ctx as unknown as DaemonContext,
    ...(options.dashboardToken ? { dashboardToken: options.dashboardToken } : {}),
  });
  server.registerConsolidationDeploymentServices({ readinessChecker: daemon.ctx.readinessChecker });
  try {
    await server.start();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return null;
    throw error;
  }
  const read = await readOperatorCredential(file);
  if (read.kind !== "ok") throw new Error(`no credential: ${read.kind}`);
  const port = Number(new URL(read.credential.baseUrl).port);
  return { port, token: read.credential.token, file, daemon };
}

function post(port: number, path: string, headers: Record<string, string>, body: unknown = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const operator = (token: string): Record<string, string> => ({ [OPERATOR_TOKEN_HEADER]: token });

/** A job start's result: the 202's job polled over GET /api/daemon/jobs/:id until it settles. */
async function jobResult(port: number, started: Response): Promise<unknown> {
  expect(started.status).toBe(202);
  const { jobId } = (await started.json()) as { jobId: string };
  for (;;) {
    const job = (await (await fetch(`http://127.0.0.1:${port}/api/daemon/jobs/${jobId}`)).json()) as { state: string; result?: unknown; error?: string };
    if (job.state === "done") return job.result;
    if (job.state === "failed") throw new Error(job.error);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("the local operator credential file (COR-13)", () => {
  it("is written while the dashboard listens: its URL, this pid and a fresh random token, readable by this user only", async () => {
    const started = await start();
    if (!started) return;
    const credential = JSON.parse(readFileSync(started.file, "utf-8")) as { baseUrl: string; pid: number; token: string };
    expect(credential.baseUrl).toBe(`http://127.0.0.1:${started.port}`);
    expect(credential.pid).toBe(process.pid);
    expect(Buffer.from(credential.token, "base64url")).toHaveLength(32);
    if (process.platform !== "win32") {
      expect(statSync(started.file).mode & 0o777).toBe(0o600);
    }
  });

  it("is removed on stop", async () => {
    const started = await start();
    if (!started) return;
    await server!.stop();
    server = null;
    expect(existsSync(started.file)).toBe(false);
  });

  it("is left alone on stop when another run has replaced it", async () => {
    const started = await start();
    if (!started) return;
    const newer = JSON.stringify({ baseUrl: "http://127.0.0.1:1", pid: 999_999, token: "x".repeat(43) });
    writeFileSync(started.file, newer);
    await server!.stop();
    server = null;
    expect(readFileSync(started.file, "utf-8")).toBe(newer);
  });

  it("is never written into a log", async () => {
    const started = await start();
    if (!started) return;
    await post(started.port, "/api/daemon/budget/reset", operator(started.token));
    await post(started.port, "/api/daemon/stop", operator(started.token));
    await post(started.port, "/api/daemon/budget/reset", operator(`${started.token}x`));
    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls, logger.debug.mock.calls]);
    expect(logged).not.toContain(started.token);
  });
});

describe("what the operator token opens (COR-13)", () => {
  it("allowlists only routes that are owner-only for every other caller", () => {
    const samples = operatorCalls(fakeDaemon()).map((call) => call.path);
    expect(samples).toHaveLength(LOCAL_OPERATOR_ROUTES.length + 2); // three agent actions share one pattern
    for (const path of samples) {
      expect(ownerOnlyProxySurface(path), path).toBe("instance:control");
    }
  });

  it("is accepted on every allowlisted route with no Origin, no bearer and no owner identity, on a shared instance", async () => {
    const started = await start();
    if (!started) return;
    for (const call of operatorCalls(started.daemon)) {
      const res = await post(started.port, call.path, operator(started.token), call.body);
      expect(res.status, `${call.path}: ${await res.clone().text()}`).toBe(call.status);
      expect(call.spy, call.path).toHaveBeenCalled();
    }
  });

  it("stands in for the dashboard bearer on those routes", async () => {
    const started = await start({ dashboardToken: "dashboard-secret" });
    if (!started) return;
    const res = await post(started.port, "/api/daemon/budget/reset", operator(started.token));
    expect(res.status).toBe(200);
    expect(started.daemon.ctx.budgetTracker.resetBudget).toHaveBeenCalledTimes(1);
  });

  it("with a wrong or missing token, falls through to the existing gates", async () => {
    const started = await start();
    if (!started) return;
    for (const headers of [{}, operator("wrong"), operator(`${started.token}x`), operator(started.token.slice(1))]) {
      const res = await post(started.port, "/api/daemon/budget/reset", headers);
      expect(res.status).toBe(403);
    }
    expect(started.daemon.ctx.budgetTracker.resetBudget).not.toHaveBeenCalled();
    await server!.stop();

    const withBearer = await start({ dashboardToken: "dashboard-secret" });
    if (!withBearer) return;
    const res = await post(withBearer.port, "/api/daemon/budget/reset", operator("wrong"));
    expect(res.status).toBe(401);
    expect(withBearer.daemon.ctx.budgetTracker.resetBudget).not.toHaveBeenCalled();
  });

  it("is ignored anywhere but its header: never read from a query string", async () => {
    const started = await start();
    if (!started) return;
    const inQuery = await post(started.port, `/api/daemon/budget/reset?${OPERATOR_TOKEN_HEADER}=${started.token}`, {});
    expect(inQuery.status).toBe(403);
    const alsoQuery = await post(started.port, `/api/daemon/budget/reset?token=${started.token}`, operator(started.token));
    expect(alsoQuery.status).toBe(403);
    expect(started.daemon.ctx.budgetTracker.resetBudget).not.toHaveBeenCalled();
  });

  it("opens no route outside the allowlist", async () => {
    const started = await start({ dashboardToken: "dashboard-secret" });
    if (!started) return;
    // A mutation the CLI does not make.
    const stop = await post(started.port, "/api/daemon/stop", operator(started.token));
    expect(stop.status).toBe(401);
    // A read: still the bearer's.
    const read = await fetch(`http://127.0.0.1:${started.port}/api/daemon/audit`, { headers: operator(started.token) });
    expect(read.status).toBe(401);
    // An allowlisted path under another method.
    const put = await fetch(`http://127.0.0.1:${started.port}/api/daemon/budget/reset`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...operator(started.token) },
      body: "{}",
    });
    expect(put.status).toBe(401);
    expect(started.daemon.ctx.budgetTracker.resetBudget).not.toHaveBeenCalled();
  });

  it("refuses a foreign Origin, with or without the token", async () => {
    const started = await start();
    if (!started) return;
    const foreign = { Origin: "https://evil.example" };
    expect((await post(started.port, "/api/daemon/budget/reset", foreign)).status).toBe(403);
    expect((await post(started.port, "/api/daemon/budget/reset", { ...foreign, ...operator(started.token) })).status).toBe(403);
    expect(started.daemon.ctx.budgetTracker.resetBudget).not.toHaveBeenCalled();
  });

  it("never approves a CORS preflight, so a browser page cannot send the header cross-origin", async () => {
    const started = await start();
    if (!started) return;
    for (const call of operatorCalls(started.daemon)) {
      const res = await fetch(`http://127.0.0.1:${started.port}${call.path}`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": `${OPERATOR_TOKEN_HEADER}, content-type`,
        },
      });
      expect(res.headers.get("access-control-allow-origin"), call.path).toBeNull();
      expect(res.headers.get("access-control-allow-headers"), call.path).toBeNull();
      expect(res.headers.get("access-control-allow-methods"), call.path).toBeNull();
      expect(call.spy, call.path).not.toHaveBeenCalled();
    }
  });

  it("refuses a guest identity on every new owner-only route, and serves the owner", async () => {
    const started = await start();
    if (!started) return;
    const self = { Origin: `http://127.0.0.1:${started.port}` };
    for (const call of operatorCalls(started.daemon)) {
      const guest = await post(started.port, call.path, { ...self, ...as("guest-profile") }, call.body);
      expect(guest.status, call.path).toBe(403);
      expect(call.spy, call.path).not.toHaveBeenCalled();
      const owner = await post(started.port, call.path, { ...self, ...as("owner-profile") }, call.body);
      expect(owner.status, call.path).toBe(call.status);
    }
  });

  it("requires a JSON body by declared type, validated before anything changes", async () => {
    const started = await start();
    if (!started) return;
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const res = await post(started.port, "/api/daemon/budget/reset", { ...operator(started.token), "Content-Type": type }, "{}");
      expect(res.status, type).toBe(415);
    }
    const unknownKey = await post(started.port, "/api/daemon/budget/reset", operator(started.token), { all: true });
    expect(unknownKey.status).toBe(400);
    const notAnObject = await post(started.port, "/api/daemon/budget/reset", operator(started.token), "null");
    expect(notAnObject.status).toBe(400);
    const badLevel = await post(started.port, "/api/daemon/notify", operator(started.token), { level: "loud", message: "x" });
    expect(badLevel.status).toBe(400);
    const badAmount = await post(started.port, `/api/agents/${AGENT}/budget`, operator(started.token), { usd: -1 });
    expect(badAmount.status).toBe(400);
    expect(started.daemon.ctx.budgetTracker.resetBudget).not.toHaveBeenCalled();
    expect(started.daemon.ctx.notificationRouter.notify).not.toHaveBeenCalled();
    expect(started.daemon.ctx.agentManager.setBudgetCap).not.toHaveBeenCalled();
  });
});

describe("the daemon control routes do what the in-process commands do (COR-13)", () => {
  it("fires, resets and persists by trigger name, and names a trigger it cannot find", async () => {
    const started = await start();
    if (!started) return;
    const fired = await post(started.port, "/api/daemon/trigger", operator(started.token), { name: "nightly" });
    expect(fired.status).toBe(200);
    expect(await fired.json()).toEqual({ trigger: "nightly", status: "submitted", taskId: "task_1" });
    expect(started.daemon.fireNow).toHaveBeenCalledWith("nightly");

    const missing = await post(started.port, "/api/daemon/trigger", operator(started.token), { name: "nope" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ trigger: "nope", status: "not_found", error: "Trigger 'nope' not found" });

    await post(started.port, "/api/daemon/circuit/reset", operator(started.token), { name: "nightly" });
    expect(started.daemon.ctx.storage.upsertCircuitState).toHaveBeenCalledWith("nightly", "CLOSED", 0, 0, 1000);
  });

  it("passes arguments through as the commands give them", async () => {
    const started = await start();
    if (!started) return;
    const { ctx } = started.daemon;
    await post(started.port, `/api/agents/${AGENT}/stop`, operator(started.token), { force: true });
    expect(ctx.agentManager.stopAgent).toHaveBeenCalledWith(AGENT, true);
    await post(started.port, `/api/agents/${AGENT}/budget`, operator(started.token), { usd: 2.5 });
    expect(ctx.agentManager.setBudgetCap).toHaveBeenCalledWith(AGENT, 2.5);
    await post(started.port, "/api/delegations/tier", operator(started.token), { type: "code_review", tier: "cheap" });
    expect(ctx.tierRouter.setOverride).toHaveBeenCalledWith("code_review", "cheap");
    await post(started.port, "/api/daemon/notify", operator(started.token), { level: "high", message: "hi" });
    expect(ctx.notificationRouter.notify).toHaveBeenCalledWith(expect.objectContaining({ level: "high", title: "Manual test", message: "hi" }));

    const undoMissing = await post(started.port, "/api/consolidation/undo", operator(started.token), { logId: "log-2" });
    expect(undoMissing.status).toBe(409);
    expect(((await undoMissing.json()) as { error: string }).error).toContain("log-2");
  });

  it("proposes a deployment only when asked to, and only when ready", async () => {
    const started = await start();
    if (!started) return;
    const { ctx } = started.daemon;
    const check = await jobResult(started.port, await post(started.port, "/api/deployment/check", operator(started.token), {}));
    expect(check).toMatchObject({ ready: true });
    expect(check).not.toHaveProperty("proposed");
    expect(ctx.deployTrigger.triggerReadinessCheck).not.toHaveBeenCalled();

    const propose = await jobResult(started.port, await post(started.port, "/api/deployment/check", operator(started.token), { propose: true }));
    expect(propose).toMatchObject({ ready: true, proposed: true });
    expect(ctx.deployTrigger.triggerReadinessCheck).toHaveBeenCalledTimes(1);
  });

  it("serves the reads the CLI makes, and a digest preview sends nothing", async () => {
    const started = await start();
    if (!started) return;
    const { ctx } = started.daemon;
    const audit = await fetch(`http://127.0.0.1:${started.port}/api/daemon/audit?limit=5`);
    expect(await audit.json()).toMatchObject({ enabled: true, entries: [{ toolName: "shell_exec" }] });
    expect(ctx.approvalQueue.getAuditLog).toHaveBeenCalledWith(5);

    const notifications = await fetch(`http://127.0.0.1:${started.port}/api/daemon/notifications?limit=3&level=high`);
    expect(await notifications.json()).toEqual({ enabled: true, entries: [] });
    expect(ctx.notificationRouter.getHistory).toHaveBeenCalledWith(3, "high");

    const preview = await fetch(`http://127.0.0.1:${started.port}/api/daemon/digest/preview`);
    expect(await preview.json()).toEqual({ enabled: true, markdown: "**preview**" });
    expect(ctx.digestReporter.sendDigest).not.toHaveBeenCalled();

    const clusters = await fetch(`http://127.0.0.1:${started.port}/api/consolidation/preview`);
    expect(await clusters.json()).toEqual({ enabled: true, clusters: [], estimatedCostPerCluster: 0, totalEstimatedCost: 0 });
  });

  it("answers 503 for a change and enabled:false for a read when the runtime runs without daemon mode", async () => {
    const file = join(dir, "no-daemon.operator.json");
    server = new DashboardServer(0, new MetricsCollector(), () => undefined, () => false, [], "127.0.0.1", [], file);
    try {
      await server.start();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const read = await readOperatorCredential(file);
    if (read.kind !== "ok") throw new Error("no credential");
    const port = Number(new URL(read.credential.baseUrl).port);
    const change = await post(port, "/api/daemon/budget/reset", operator(read.credential.token));
    expect(change.status).toBe(503);
    expect(((await change.json()) as { error: string }).error).toContain("Daemon mode is not enabled");
    const audit = await fetch(`http://127.0.0.1:${port}/api/daemon/audit`);
    expect(await audit.json()).toMatchObject({ enabled: false });
  });
});

describe("long operations run as jobs the CLI polls (COR-13 follow-up)", () => {
  const getJob = async (port: number, id: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/api/daemon/jobs/${id}`, { headers });

  it("answers 202 { jobId } at once, reports the job running, then done with the cycle's result", async () => {
    const started = await start();
    if (!started) return;
    let finish!: (value: unknown) => void;
    started.daemon.ctx.consolidationEngine.runCycle.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }) as never);

    const res = await post(started.port, "/api/consolidation/run", operator(started.token));
    expect(res.status).toBe(202);
    const { jobId, kind, state } = (await res.json()) as { jobId: string; kind: string; state: string };
    expect([kind, state]).toEqual(["memory:consolidate", "running"]);

    const running = await getJob(started.port, jobId);
    expect(running.status).toBe(200);
    expect(await running.json()).toMatchObject({ id: jobId, kind: "memory:consolidate", state: "running" });

    finish({ status: "completed", processed: 2, remaining: 0, clustersFound: 2, costUsd: 0.01 });
    await vi.waitFor(async () => {
      expect(await (await getJob(started.port, jobId)).json()).toMatchObject({
        state: "done",
        result: { status: "completed", processed: 2 },
      });
    });
  });

  it("reports a failed job with its error", async () => {
    const started = await start();
    if (!started) return;
    started.daemon.ctx.consolidationEngine.runCycle.mockImplementationOnce(async () => {
      throw new Error("LLM provider unavailable");
    });
    const { jobId } = (await (await post(started.port, "/api/consolidation/run", operator(started.token))).json()) as { jobId: string };
    await vi.waitFor(async () => {
      expect(await (await getJob(started.port, jobId)).json()).toMatchObject({ state: "failed", error: "LLM provider unavailable" });
    });
  });

  it("runs one job per kind: a second start while one runs is a 409 naming it, and starts nothing", async () => {
    const started = await start();
    if (!started) return;
    const { ctx } = started.daemon;
    ctx.readinessChecker.checkReadiness.mockImplementationOnce(() => new Promise(() => undefined));
    const first = await post(started.port, "/api/deployment/check", operator(started.token), {});
    const { jobId } = (await first.json()) as { jobId: string };

    const second = await post(started.port, "/api/deployment/check", operator(started.token), { propose: true });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: `A deploy:check job is already running: ${jobId}`, jobId });
    expect(ctx.readinessChecker.checkReadiness).toHaveBeenCalledTimes(1);

    // Another kind is not held up by it.
    expect((await post(started.port, "/api/consolidation/run", operator(started.token))).status).toBe(202);
  });

  it("answers 404 for a job it does not have", async () => {
    const started = await start();
    if (!started) return;
    for (const id of ["0f8fad5b-d9cb-469f-a165-70867728950e", "not-a-job", "0F8FAD5B-D9CB-469F-A165-70867728950E"]) {
      const res = await getJob(started.port, id);
      expect(res.status, id).toBe(404);
      expect(((await res.json()) as { error: string }).error).toContain("No such job");
    }
  });

  it("serves the job read through the dashboard's read gates: the bearer, never the operator token", async () => {
    const started = await start({ dashboardToken: "dashboard-secret" });
    if (!started) return;
    const { jobId } = (await (await post(started.port, "/api/consolidation/run", operator(started.token))).json()) as { jobId: string };

    expect((await getJob(started.port, jobId, operator(started.token))).status).toBe(401);
    expect((await getJob(started.port, jobId)).status).toBe(401);
    expect((await getJob(started.port, jobId, { Authorization: "Bearer dashboard-secret" })).status).toBe(200);
    // A read, not an owner-only power: the portal's table does not list it.
    expect(ownerOnlyProxySurface(`/api/daemon/jobs/${jobId}`)).toBeUndefined();
  });

  it("answers a runtime without deployment at once, with no job", async () => {
    const file = join(dir, "no-deploy.operator.json");
    server = new DashboardServer(0, new MetricsCollector(), () => undefined, () => false, [], "127.0.0.1", [], file);
    try {
      await server.start();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const read = await readOperatorCredential(file);
    if (read.kind !== "ok") throw new Error("no credential");
    const port = Number(new URL(read.credential.baseUrl).port);
    const res = await post(port, "/api/deployment/check", operator(read.credential.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });
});
