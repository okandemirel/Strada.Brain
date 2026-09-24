/**
 * EVERY MUTATION ON THE DASHBOARD PORT IS CLASSIFIED **AND ENFORCED**.
 *
 * ROUND 15 #5 — WHY THIS FILE WAS REWRITTEN. The first version of this tripwire
 * compared the route guards in the source against a table of decisions, and
 * nothing else. Codex measured it the only way that counts: it deleted all four
 * `allowCanvas()` calls AND the dashboard's central ownership gate, and all four
 * tests still passed. A coverage test that survives the removal of every guard it
 * claims to cover is worse than no test, because the next reader trusts something
 * that was never measured — the same defect class as a green verdict nobody
 * measured.
 *
 * So each row now carries a PROBE that drives the real dispatch and asserts the
 * refusal: a guest is refused, nothing is mutated, and the owner is still served.
 * The table cannot drift from behaviour, because the table is what runs the
 * behaviour.
 *
 *   central-owner-only   the instance itself changes; refused in server.ts off
 *                        `ownerOnlyProxySurface`. Probed through a REAL
 *                        DashboardServer over HTTP.
 *   handler-owner-only   owner-only, but decided inside the handler (it needs the
 *                        request body, or its own project state).
 *   own-identity         one identity's own traffic, authorized in the handler
 *                        against the resource's owner.
 *   self-guarded         not the shared-instance model's business — and the probe
 *                        has to demonstrate that claim, not assert it.
 *
 * A new mutating route, or a reworded guard, fails the first test until somebody
 * writes down which of those it is and probes it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ownerOnlyProxySurface, type InstanceSurface } from "../channels/web/instance-access.js";
import { setInstanceIdentityStore } from "../channels/web/instance-authorization.js";
import { DashboardServer } from "./server.js";
import { MetricsCollector } from "./metrics.js";
import { CanvasStorage } from "./canvas-storage.js";
import { handleCanvasRoute } from "./canvas-routes.js";
import { handleChangeReviewRoute } from "./change-review-routes.js";
import { handleMonitorRoute, MonitorActivityLog } from "./monitor-routes.js";
import { handleProjectHistoryRoutes } from "./project-history-routes.js";
import { TypedEventBus } from "../core/event-bus.js";
import type { WorkspaceEventMap } from "./workspace-events.js";
import { createMockReq, createMockRes, responseJson, type MockRes } from "./test-support/mock-http.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./server-types.js";

// The dashboard server logs through the initialized logger; tests do not boot one.
vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  const stub = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { ...actual, getLogger: () => stub, getLoggerSafe: () => stub };
});

const OWNER = "owner-profile";
const GUEST = "guest-profile";

const as = (profileId: string): Record<string, string> => ({
  "x-strada-profile-id": profileId,
  "x-strada-profile-token": `token-${profileId}`,
});

/** The instance: owner first, one guest — i.e. genuinely shared. */
function identities() {
  const issued = [OWNER, GUEST];
  return {
    verify: (profileId: string, token: string) => issued.includes(profileId) && token === `token-${profileId}`,
    ownerProfileId: () => OWNER,
    has: (profileId: string) => issued.includes(profileId),
    count: () => issued.length,
  };
}

// ── Driving the handlers ──────────────────────────────────────────────────────

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function reqWith(headers: Record<string, string>, body?: unknown): IncomingMessage {
  const req = createMockReq(body === undefined ? undefined : JSON.stringify(body));
  (req as unknown as { headers: Record<string, string> }).headers = headers;
  return req;
}

/** Wait for a handler that answers asynchronously. */
function answered(res: MockRes & ServerResponse): Promise<{ status: number; json: Record<string, unknown>; body: string }> {
  return new Promise((resolve) => {
    const wait = (): void => {
      if (res.end.mock.calls.length > 0) {
        resolve({ status: res.statusCode, json: responseJson(res), body: res.body });
        return;
      }
      setImmediate(wait);
    };
    wait();
  });
}

// ── The real dashboard server, for the centrally gated rows ──────────────────
//
// NO services are registered on purpose: a handler that runs answers 501/503, so
// "403 with our reason" vs "anything else" distinguishes *the gate refused* from
// *the gate let it through* for every row, with no per-route mocking.

let server: DashboardServer | null = null;
let port = 0;

beforeAll(async () => {
  const metrics = new MetricsCollector();
  server = new DashboardServer(0, metrics, () => undefined);
  try {
    await server.start();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { server = null; return; }
    throw error;
  }
  const addr = (server as unknown as { server: { address: () => { port: number } | string | null } }).server.address();
  port = addr && typeof addr !== "string" ? addr.port : 0;
});

afterAll(async () => {
  if (server) await server.stop();
  server = null;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => setInstanceIdentityStore(identities()));
afterEach(() => setInstanceIdentityStore(null));

async function postToServer(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method: "POST",
    headers: { Origin: `http://localhost:${port}`, "Content-Type": "application/json", ...headers },
    body: "{}",
  });
  return { status: res.status, body: await res.text() };
}

/**
 * The generic probe for a centrally gated route: through the real server, a guest
 * is refused BY NAME and the owner is not. Deleting the gate in server.ts breaks
 * every row at once, which is exactly what round 15 #5 asked for.
 */
async function probeCentral(sample: string): Promise<void> {
  if (!server) return; // sandbox without listen permission
  const guest = await postToServer(sample, as(GUEST));
  expect(guest.status, `${sample} as a guest`).toBe(403);
  expect(guest.body, `${sample} must name the refused identity`).toContain(GUEST);

  const owner = await postToServer(sample, as(OWNER));
  expect(owner.status, `${sample} as the owner must pass the gate`).not.toBe(403);
}

// ── Probes for the handler-enforced rows ─────────────────────────────────────

/** A canvas storage holding one canvas owned by OWNER. */
function canvasFixture(): { storage: CanvasStorage; close: () => void } {
  const db = new Database(join(tempDir("cov-canvas-"), "canvas.db"));
  const storage = new CanvasStorage(db);
  storage.save({
    id: OWNER,
    sessionId: OWNER,
    userId: OWNER,
    shapes: JSON.stringify([{ id: "s1", type: "note", text: "the owner's plan" }]),
    connections: "[]",
    createdAt: 1,
    updatedAt: 1,
  });
  return { storage, close: () => db.close() };
}

async function callCanvas(
  storage: CanvasStorage,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = createMockRes();
  expect(handleCanvasRoute(url, method, reqWith(headers, body), res, storage)).toBe(true);
  const { status, json } = await answered(res);
  return { status, json };
}

/** Guest refused, owner served, and the owner's shapes untouched either way. */
async function probeCanvas(method: string, url: string, body?: unknown): Promise<void> {
  const { storage, close } = canvasFixture();
  try {
    const guest = await callCanvas(storage, method, url, as(GUEST), body);
    expect(guest.status, `${method} ${url} as a guest`).toBe(403);
    expect(String(guest.json["reason"] ?? "")).toContain(GUEST);
    // Nothing moved: the row, its shapes and its owner are as they were.
    const after = storage.getBySession(OWNER);
    expect(after, `${method} ${url} must not delete the owner's canvas`).not.toBeNull();
    expect(after!.shapes).toContain("the owner's plan");
    expect(after!.userId).toBe(OWNER);

    const owner = await callCanvas(storage, method, url, as(OWNER), body);
    expect(owner.status, `${method} ${url} as the owner`).toBe(200);
  } finally {
    close();
  }
}

/**
 * The change-review decisions route. Authorization runs BEFORE the review is
 * loaded, so on a project with no review a guest gets 403 and the owner gets 404 —
 * which is all this probe needs: the 404 proves the gate let the owner through.
 */
async function probeChangeReview(): Promise<void> {
  const root = tempDir("cov-review-");
  const url = "/api/workspace/change-review/review-1/decisions";
  const guestRes = createMockRes();
  expect(handleChangeReviewRoute(url, "POST", reqWith(as(GUEST), { decisions: [{ path: "a", decision: "undo" }] }), guestRes, root)).toBe(true);
  const guest = await answered(guestRes);
  expect(guest.status, "change-review decisions as a guest").toBe(403);
  expect(String(guest.json["reason"] ?? "")).toContain(GUEST);

  const ownerRes = createMockRes();
  handleChangeReviewRoute(url, "POST", reqWith(as(OWNER), { decisions: [{ path: "a", decision: "undo" }] }), ownerRes, root);
  const owner = await answered(ownerRes);
  expect(owner.status, "change-review decisions as the owner must pass the gate").not.toBe(403);
}

/** A task manager whose single task belongs to OWNER. */
function monitorTaskManager() {
  return {
    listAllActiveTasks: vi.fn(() => [{
      id: "task-owner",
      chatId: "chat-owner",
      channelType: "web",
      userId: OWNER,
      title: "the owner's run",
      status: "executing",
      createdAt: 1,
      updatedAt: 2,
    }]),
  } as unknown as Parameters<typeof handleMonitorRoute>[5];
}

async function probeMonitorGate(action: "approve" | "skip"): Promise<void> {
  const bus = new TypedEventBus<WorkspaceEventMap>();
  const seen: unknown[] = [];
  bus.on("monitor:gate_response" as keyof WorkspaceEventMap, ((event: unknown) => seen.push(event)) as never);
  const log = new MonitorActivityLog();
  const url = `/api/monitor/task/task-owner/${action}`;

  const guestRes = createMockRes();
  expect(handleMonitorRoute(url, "POST", reqWith(as(GUEST), { rootId: "root-1" }), guestRes, undefined, monitorTaskManager(), bus as never, log)).toBe(true);
  const guest = await answered(guestRes);
  expect(guest.status, `${url} as a guest`).toBe(403);
  // The decision did NOT reach the run.
  expect(seen, `${url} must emit nothing for a guest`).toEqual([]);

  const ownerRes = createMockRes();
  handleMonitorRoute(url, "POST", reqWith(as(OWNER), { rootId: "root-1" }), ownerRes, undefined, monitorTaskManager(), bus as never, log);
  const owner = await answered(ownerRes);
  expect(owner.status, `${url} as the owner`).toBe(200);
  expect(seen).toHaveLength(1);
}

/** The monitor export: a READ expressed as POST. Its claim is "changes nothing". */
async function probeMonitorExport(): Promise<void> {
  const bus = new TypedEventBus<WorkspaceEventMap>();
  const emitted: unknown[] = [];
  for (const event of ["monitor:gate_response", "monitor:pause", "monitor:resume"] as const) {
    bus.on(event as keyof WorkspaceEventMap, ((payload: unknown) => emitted.push(payload)) as never);
  }
  const res = createMockRes();
  expect(handleMonitorRoute("/api/monitor/export", "POST", reqWith(as(GUEST)), res, undefined, undefined, bus as never, new MonitorActivityLog())).toBe(true);
  const answer = await answered(res);
  // It answers a document and emits nothing: nothing to authorize as a mutation.
  expect(emitted, "the export must not drive the run").toEqual([]);
  expect(answer.status).toBeLessThan(500);
}

/** Project history: every non-GET is 405, which is the whole claim. */
async function probeHistoryReadOnly(): Promise<void> {
  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = createMockRes();
    const handled = handleProjectHistoryRoutes(
      "/api/workspace/history",
      method,
      reqWith(as(GUEST)),
      res,
      { daemonStorage: undefined } as unknown as RouteContext,
    );
    expect(handled).toBe(true);
    expect(res.statusCode, `history ${method}`).toBe(405);
  }
}

/**
 * The webhook: authenticated by its own secret, and deliberately excluded from the
 * ownership gate. The claim to demonstrate is that the exclusion does not leave it
 * open — with no secret configured it refuses, and it never answers with the
 * shared-instance model's grant.
 */
async function probeWebhook(): Promise<void> {
  if (!server) return;
  const guest = await postToServer("/api/webhook", as(GUEST));
  expect(guest.status, "webhook with no secret configured").not.toBe(200);
}

/** The central gate is wired at all: the row for `isMutableDashboardApi` itself. */
async function probeCentralGateWired(): Promise<void> {
  await probeCentral("/api/daemon/stop");
}

// ── THE TABLE ────────────────────────────────────────────────────────────────

type Enforcement =
  | { readonly kind: "central-owner-only"; readonly surface: InstanceSurface; readonly sample: string }
  | { readonly kind: "handler-owner-only"; readonly why: string; readonly probe: () => Promise<void> }
  | { readonly kind: "own-identity"; readonly why: string; readonly probe: () => Promise<void> }
  | { readonly kind: "self-guarded"; readonly why: string; readonly probe: () => Promise<void> };

interface MutationRoute {
  /** The guard line, verbatim, so rewording it forces this table to be re-read. */
  readonly guard: string;
  readonly enforcement: Enforcement;
}

const MUTATIONS: Readonly<Record<string, readonly MutationRoute[]>> = {
  "canvas-routes.ts": [
    {
      guard: `if (method === "POST" && exportMatch) {`,
      enforcement: {
        kind: "own-identity",
        why: "round 14 #2: a canvas is the identity's own work; allowCanvas() checks the row's owner",
        probe: () => probeCanvas("POST", `/api/canvas/${OWNER}/export`),
      },
    },
    {
      guard: `if (method === "PUT" && sessionMatch) {`,
      enforcement: {
        kind: "own-identity",
        why: "round 14 #2 + round 15 #1: allowCanvas(), the owner column from the verified pair, and the storage id from the row — never the body",
        probe: () => probeCanvas("PUT", `/api/canvas/${OWNER}`, { shapes: [{ id: "x", type: "note" }] }),
      },
    },
    {
      guard: `if (method === "DELETE" && deleteMatch) {`,
      enforcement: {
        kind: "own-identity",
        why: "round 14 #2: the guest DELETE that reached storage and answered 200",
        probe: () => probeCanvas("DELETE", `/api/canvas/${OWNER}`),
      },
    },
  ],
  "change-review-routes.ts": [
    {
      guard: `if (method !== "POST") {`,
      enforcement: {
        // ROUND 15 #5 also corrected this label: a keep or a revert writes the
        // user's project and moves git HEAD, so the route asks for
        // instance:control — owner-only — and decides it itself because it needs
        // the body and the project's own state.
        kind: "handler-owner-only",
        why: "round 12 #10: instance:control in allowed(); the owner decides, a guest is refused, an unreadable identity store is 503",
        probe: probeChangeReview,
      },
    },
  ],
  "monitor-routes.ts": [
    {
      guard: `if (method === 'POST' && approveMatch) {`,
      enforcement: {
        kind: "own-identity",
        why: "round 14 sweep: task:control against the task's owning identity, mirroring the WS monitor:approve_gate",
        probe: () => probeMonitorGate("approve"),
      },
    },
    {
      guard: `if (method === 'POST' && skipMatch) {`,
      enforcement: {
        kind: "own-identity",
        why: "round 14 sweep: task:control against the task's owning identity, mirroring the WS monitor:skip_task",
        probe: () => probeMonitorGate("skip"),
      },
    },
    {
      guard: `if (method === 'POST' && (url === '/api/monitor/export' || url.startsWith('/api/monitor/export?'))) {`,
      enforcement: {
        kind: "self-guarded",
        why:
          "a READ expressed as POST: it renders the active goal tree as markdown, drives nothing and changes nothing. "
          + "Its per-identity scoping is the monitor:frames problem and is NOT closed here — an identified caller can "
          + "still read the instance's active tree titles. Tracked, deliberately open, not silently unclassified.",
        probe: probeMonitorExport,
      },
    },
  ],
  "project-history-routes.ts": [
    {
      guard: `if (method !== "GET") {`,
      enforcement: {
        kind: "self-guarded",
        why: "read-only surface: every non-GET is 405. Its READS are scoped by the verified identity (round 13 #4)",
        probe: probeHistoryReadOnly,
      },
    },
  ],
  "server-daemon-routes.ts": [
    {
      guard: `if (url.startsWith("/api/daemon/approvals/") && method === "POST") {`,
      enforcement: { kind: "central-owner-only", surface: "instance:control", sample: "/api/daemon/approvals/a1/approve" },
    },
    {
      guard: `if ((url === "/api/daemon/start" || url === "/api/daemon/stop") && method === "POST") {`,
      enforcement: { kind: "central-owner-only", surface: "instance:control", sample: "/api/daemon/stop" },
    },
    {
      guard: `if (method === "POST" && url === "/api/update") {`,
      enforcement: { kind: "central-owner-only", surface: "instance:control", sample: "/api/update" },
    },
    {
      guard: `if (method === "POST" && (url === "/api/webhook" || url.startsWith("/api/webhook?"))) {`,
      enforcement: {
        kind: "self-guarded",
        why:
          "an external trigger endpoint, not a portal surface: it authenticates with the webhook secret (HMAC) and is "
          + "excluded from isMutableDashboardApi in server.ts on purpose — a shared-instance identity is not what calls it",
        probe: probeWebhook,
      },
    },
  ],
  "server-mcp-routes.ts": [
    {
      guard: `if (method !== "POST") {`,
      enforcement: { kind: "central-owner-only", surface: "instance:control", sample: "/api/mcp/reconnect" },
    },
  ],
  "server-personality-routes.ts": [
    {
      guard: `if (method === "POST" && url === "/api/personality/profiles") {`,
      enforcement: { kind: "central-owner-only", surface: "setup:write", sample: "/api/personality/profiles" },
    },
    {
      guard: `if (method === "DELETE" && url.startsWith("/api/personality/profiles/")) {`,
      enforcement: { kind: "central-owner-only", surface: "setup:write", sample: "/api/personality/profiles/mentor" },
    },
    {
      guard: `if (method === "POST" && url === "/api/personality/switch") {`,
      enforcement: { kind: "central-owner-only", surface: "setup:write", sample: "/api/personality/switch" },
    },
    {
      // ROUND 15 #3: this guard used `startsWith("/api/user/autonomous")`, which
      // `/api/user/autonomousXYZ` satisfied while the classification table did
      // not — so the suffix reached the handler ungated. It matches the canonical
      // pathname exactly now, and `anchoring` below is the rule for every route.
      guard: `if (method === "POST" && canonicalPath(url) === "/api/user/autonomous") {`,
      enforcement: { kind: "central-owner-only", surface: "instance:control", sample: "/api/user/autonomous" },
    },
  ],
  "server-provider-routes.ts": [
    {
      guard: `if (method === "POST" && url === "/api/providers/switch") {`,
      enforcement: { kind: "central-owner-only", surface: "setup:write", sample: "/api/providers/switch" },
    },
    {
      // ROUND 14 #5: two spellings, one handler. Both are asserted below.
      guard: `if (method === "POST" && (url === "/api/models/refresh" || url === "/api/providers/models/refresh")) {`,
      enforcement: { kind: "central-owner-only", surface: "setup:write", sample: "/api/providers/models/refresh" },
    },
    {
      guard: `if (method === "POST" && url === "/api/routing/preset") {`,
      enforcement: { kind: "central-owner-only", surface: "setup:write", sample: "/api/routing/preset" },
    },
  ],
  "server-settings-routes.ts": [
    {
      guard: `if (url === "/api/budget/config" && method === "POST") {`,
      enforcement: { kind: "central-owner-only", surface: "setup:write", sample: "/api/budget/config" },
    },
    {
      guard: `if (url === "/api/settings/rate-limits" && method === "POST") {`,
      enforcement: { kind: "central-owner-only", surface: "setup:write", sample: "/api/settings/rate-limits" },
    },
    {
      guard: `if (method === "POST") {`,
      enforcement: { kind: "central-owner-only", surface: "setup:write", sample: "/api/settings/voice" },
    },
  ],
  "server-skills-routes.ts": [
    {
      guard: `if (url === "/api/skills/install" && method === "POST") {`,
      enforcement: { kind: "central-owner-only", surface: "setup:write", sample: "/api/skills/install" },
    },
    {
      guard: `if (enableMatch && method === "POST") {`,
      enforcement: { kind: "central-owner-only", surface: "setup:write", sample: "/api/skills/some-skill/enable" },
    },
    {
      guard: `if (disableMatch && method === "POST") {`,
      enforcement: { kind: "central-owner-only", surface: "setup:write", sample: "/api/skills/some-skill/disable" },
    },
  ],
  "server-system-routes.ts": [
    {
      guard: `if (url === "/api/deployment/check" && method === "POST") {`,
      enforcement: { kind: "central-owner-only", surface: "instance:control", sample: "/api/deployment/check" },
    },
  ],
  "server-vault-routes.ts": [
    {
      guard: `if (pathOnly === '/api/vaults' && method === 'POST') {`,
      enforcement: { kind: "central-owner-only", surface: "setup:write", sample: "/api/vaults" },
    },
    {
      guard: `if (deleteMatch && method === 'DELETE') {`,
      enforcement: { kind: "central-owner-only", surface: "setup:write", sample: "/api/vaults/v1" },
    },
    {
      guard: `if (regenCanvasMatch && method === 'POST') {`,
      enforcement: { kind: "central-owner-only", surface: "setup:write", sample: "/api/vaults/v1/canvas" },
    },
    {
      guard: `if (summarizeMatch && method === 'POST') {`,
      enforcement: { kind: "central-owner-only", surface: "setup:write", sample: "/api/vaults/v1/summarize" },
    },
    {
      guard: `if (op === 'search' && method === 'POST') {`,
      enforcement: { kind: "central-owner-only", surface: "setup:write", sample: "/api/vaults/v1/search" },
    },
    {
      guard: `if (op === 'sync' && method === 'POST') {`,
      enforcement: { kind: "central-owner-only", surface: "setup:write", sample: "/api/vaults/v1/sync" },
    },
  ],
  "server.ts": [
    {
      guard: `method !== "GET" &&`,
      enforcement: {
        kind: "self-guarded",
        why: "not a route: this is isMutableDashboardApi itself, the computation the central gate is driven from",
        probe: probeCentralGateWired,
      },
    },
    {
      // CHN-5: the exact webhook route is exempted from the global bearer gate
      // so its own secret can be used; validateWebhookAuth still decides.
      guard: `method === "POST" && (url === "/api/webhook" || url.startsWith("/api/webhook?"));`,
      enforcement: {
        kind: "self-guarded",
        why: "not a route: it names the one route exempted from the central gates, which authenticates itself (see the server-daemon-routes.ts webhook row)",
        probe: probeWebhook,
      },
    },
  ],
};

const dashboardDir = join(__dirname);

/** Every guard in a route module that admits a mutating method. */
function guardsIn(file: string): string[] {
  const guard = /method\s*(===|!==)\s*['"](POST|PUT|DELETE|PATCH|GET)['"]/;
  return readFileSync(join(dashboardDir, file), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("*") && !line.startsWith("//") && !line.startsWith("/*"))
    .filter((line) => guard.test(line) && !/method === ['"]GET['"]/.test(line));
}

function routeModules(): string[] {
  return readdirSync(dashboardDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();
}

const rows = Object.entries(MUTATIONS).flatMap(([file, routes]) => routes.map((route) => ({ file, route })));

describe("every dashboard mutation is classified (round 14 sweep)", () => {
  it("has a written decision for every mutating route guard, in every module", () => {
    const unclassified: string[] = [];
    const stale: string[] = [];

    for (const file of routeModules()) {
      const found = guardsIn(file);
      const documented = (MUTATIONS[file] ?? []).map((row) => row.guard);
      for (const guard of found) {
        if (!documented.includes(guard)) unclassified.push(`${file}: ${guard}`);
      }
      for (const guard of documented) {
        if (!found.includes(guard)) stale.push(`${file}: ${guard}`);
      }
    }

    expect(
      unclassified,
      "a mutating route with no decision written down. Add it to MUTATIONS with central-owner-only "
        + "(and its surface in instance-access.ts), handler-owner-only or own-identity (and the check in its "
        + `handler), or self-guarded (and why) — each with a probe that proves it:\n${unclassified.join("\n")}`,
    ).toEqual([]);
    expect(
      stale,
      `MUTATIONS names a guard that no longer exists — re-read the route before deleting the row:\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  it("classifies each centrally gated sample exactly as the live table does", () => {
    for (const { file, route } of rows) {
      if (route.enforcement.kind !== "central-owner-only") continue;
      expect(ownerOnlyProxySurface(route.enforcement.sample), `${file}: ${route.enforcement.sample}`)
        .toBe(route.enforcement.surface);
    }
  });

  // ROUND 14 #5, stated as the invariant rather than the instance.
  it("classifies aliases of the same power identically", () => {
    const aliases: ReadonlyArray<readonly [string, string]> = [
      ["/api/models/refresh", "/api/providers/models/refresh"],
    ];
    for (const [left, right] of aliases) {
      expect(ownerOnlyProxySurface(left), `${left} vs ${right}`).toBe(ownerOnlyProxySurface(right));
      expect(ownerOnlyProxySurface(left)).toBeDefined();
    }
  });
});

// ── ROUND 15 #5: the enforcement itself ──────────────────────────────────────
describe("every dashboard mutation is ENFORCED (round 15 #5)", () => {
  for (const { file, route } of rows) {
    const label = `${file}: ${route.guard}`;
    if (route.enforcement.kind === "central-owner-only") {
      it(`refuses a guest and serves the owner — ${label}`, async () => {
        await probeCentral((route.enforcement as { sample: string }).sample);
      }, 20_000);
      continue;
    }
    it(`refuses a guest and serves the owner — ${label}`, async () => {
      await (route.enforcement as { probe: () => Promise<void> }).probe();
    }, 20_000);
  }
});

// ── ROUND 15 #3: the authorized path and the acted-on path are one value ─────
describe("a route acts only on the path it was authorized for (round 15 #3)", () => {
  /**
   * The shape: `url.startsWith("/api/user/autonomous")` admitted
   * `/api/user/autonomousXYZ`, which the classification table does not match — so
   * the central gate saw an unclassified path and the handler acted anyway. Any
   * prefix match that is not slash- or query-terminated can do this, so the rule
   * is checked statically over every mutating guard rather than on one route.
   */
  it("uses no unanchored path prefix in any mutating route guard", () => {
    const offenders: string[] = [];
    for (const file of routeModules()) {
      for (const guard of guardsIn(file)) {
        for (const match of guard.matchAll(/startsWith\(\s*['"]([^'"]+)['"]/g)) {
          const prefix = match[1]!;
          if (!prefix.endsWith("/") && !prefix.endsWith("?")) offenders.push(`${file}: ${guard}`);
        }
      }
    }
    expect(
      offenders,
      "a mutating route matched by an unanchored prefix: `/api/xXYZ` satisfies it while the classification "
        + `table does not match it. Compare the canonical pathname instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("refuses the suffix variant of a centrally gated path, and does not act on it", async () => {
    if (!server) return;
    for (const { route } of rows) {
      if (route.enforcement.kind !== "central-owner-only") continue;
      const sample = route.enforcement.sample;
      const suffixed = await postToServer(`${sample}XYZ`, as(GUEST));
      // Never a success: the gate refuses it (403), no route claims it (404/405),
      // or a dispatch guard answers "not available" before matching (503). What
      // must not happen is a handler acting on a path nobody authorized — and
      // "did it act" is asserted with real spies for the route this defect was
      // found on (server.test.ts, round 15 #3).
      expect(suffixed.status, `${sample}XYZ answered ${suffixed.status}`).toBeGreaterThanOrEqual(400);
    }
  }, 30_000);
});
