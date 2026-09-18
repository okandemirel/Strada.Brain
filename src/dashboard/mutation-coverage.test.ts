/**
 * EVERY MUTATION ON THE DASHBOARD PORT IS CLASSIFIED — the tripwire.
 *
 * Codex round 13 #10 closed "the dashboard port bypasses owner authorization" by
 * gating mutations off the same table the portal proxy uses. Round 14 then found
 * three more holes of the same shape — a guest could delete another identity's
 * canvas (#2), `/goal cancel` reached an unrestricted handler (#3), and the
 * provider catalogue refresh had a second URL that nobody had classified (#5) —
 * and the lesson the coordinator drew is the right one: *the privilege table is
 * only as good as its coverage*. Fixing three routes by name leaves the fourth.
 *
 * So this test is the coverage itself. It reads every route module in
 * src/dashboard, collects every guard that admits a mutating method, and demands
 * that each one appear below with a decision attached. A new mutating route — or
 * a reworded guard — fails this test until somebody writes down which of these it
 * is:
 *
 *   owner-only    the instance itself changes: only the owner may, enforced
 *                 centrally in server.ts off `ownerOnlyProxySurface`;
 *   own-identity  one identity's own traffic, authorized in the handler against
 *                 the resource's owner (the shared-instance model's other scope);
 *   self-guarded  not the shared-instance model's business, and why.
 *
 * The URL samples are checked against the live classification table, so an alias
 * that is missing from it (round 14 #5 exactly) fails here too.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ownerOnlyProxySurface, type InstanceSurface } from "../channels/web/instance-access.js";

type Classification =
  | { readonly kind: "owner-only"; readonly surface: InstanceSurface; readonly sample: string }
  | { readonly kind: "own-identity"; readonly sample: string; readonly why: string }
  | { readonly kind: "self-guarded"; readonly why: string };

interface MutationRoute {
  /** The guard line, verbatim, so rewording it forces this table to be re-read. */
  readonly guard: string;
  readonly classification: Classification;
}

const MUTATIONS: Readonly<Record<string, readonly MutationRoute[]>> = {
  "canvas-routes.ts": [
    {
      guard: `if (method === "POST" && exportMatch) {`,
      classification: {
        kind: "own-identity",
        sample: "/api/canvas/some-profile/export",
        why: "round 14 #2: a canvas is the identity's own work; allowCanvas() checks the row's owner",
      },
    },
    {
      guard: `if (method === "PUT" && sessionMatch) {`,
      classification: {
        kind: "own-identity",
        sample: "/api/canvas/some-profile",
        why: "round 14 #2: allowCanvas() plus the owner column taken from the verified pair, not the body",
      },
    },
    {
      guard: `if (method === "DELETE" && deleteMatch) {`,
      classification: {
        kind: "own-identity",
        sample: "/api/canvas/some-profile",
        why: "round 14 #2: the guest DELETE that reached storage and answered 200",
      },
    },
  ],
  "change-review-routes.ts": [
    {
      guard: `if (method !== "POST") {`,
      classification: {
        kind: "own-identity",
        sample: "/api/workspace/change-review/r1/decisions",
        why: "round 12 #10: instance:control, authorized in allowed() — a keep or revert writes the user's project",
      },
    },
  ],
  "monitor-routes.ts": [
    {
      guard: `if (method === 'POST' && approveMatch) {`,
      classification: {
        kind: "own-identity",
        sample: "/api/monitor/task/task-1/approve",
        why: "round 14 sweep: task:control against the task's owning identity, mirroring the WS monitor:approve_gate",
      },
    },
    {
      guard: `if (method === 'POST' && skipMatch) {`,
      classification: {
        kind: "own-identity",
        sample: "/api/monitor/task/task-1/skip",
        why: "round 14 sweep: task:control against the task's owning identity, mirroring the WS monitor:skip_task",
      },
    },
    {
      guard: `if (method === 'POST' && (url === '/api/monitor/export' || url.startsWith('/api/monitor/export?'))) {`,
      classification: {
        kind: "self-guarded",
        why:
          "a READ expressed as POST: it renders the active goal tree as markdown and changes nothing. Its "
          + "per-identity scoping is the monitor:frames problem (the frames themselves are filtered by origin in "
          + "the web channel) and is NOT closed here — an identified caller can still read the instance's active "
          + "tree titles. Tracked, deliberately left open, not silently unclassified.",
      },
    },
  ],
  "project-history-routes.ts": [
    {
      guard: `if (method !== "GET") {`,
      classification: {
        kind: "self-guarded",
        why: "read-only surface: every non-GET is 405. Its READS are scoped by the verified identity (round 13 #4)",
      },
    },
  ],
  "server-daemon-routes.ts": [
    {
      guard: `if (url.startsWith("/api/daemon/approvals/") && method === "POST") {`,
      classification: { kind: "owner-only", surface: "instance:control", sample: "/api/daemon/approvals/a1/approve" },
    },
    {
      guard: `if ((url === "/api/daemon/start" || url === "/api/daemon/stop") && method === "POST") {`,
      classification: { kind: "owner-only", surface: "instance:control", sample: "/api/daemon/stop" },
    },
    {
      guard: `if (method === "POST" && url === "/api/update") {`,
      classification: { kind: "owner-only", surface: "instance:control", sample: "/api/update" },
    },
    {
      guard: `if (method === "POST" && (url === "/api/webhook" || url.startsWith("/api/webhook?"))) {`,
      classification: {
        kind: "self-guarded",
        why:
          "an external trigger endpoint, not a portal surface: it authenticates with the webhook secret (HMAC) and "
          + "is excluded from isMutableDashboardApi in server.ts on purpose — a shared-instance identity is not what "
          + "calls it",
      },
    },
  ],
  "server-mcp-routes.ts": [
    {
      guard: `if (method !== "POST") {`,
      classification: { kind: "owner-only", surface: "instance:control", sample: "/api/mcp/reconnect" },
    },
  ],
  "server-personality-routes.ts": [
    {
      guard: `if (method === "POST" && url === "/api/personality/profiles") {`,
      classification: { kind: "owner-only", surface: "setup:write", sample: "/api/personality/profiles" },
    },
    {
      guard: `if (method === "DELETE" && url.startsWith("/api/personality/profiles/")) {`,
      classification: { kind: "owner-only", surface: "setup:write", sample: "/api/personality/profiles/mentor" },
    },
    {
      guard: `if (method === "POST" && url === "/api/personality/switch") {`,
      classification: { kind: "owner-only", surface: "setup:write", sample: "/api/personality/switch" },
    },
    {
      guard: `if (method === "POST" && url.startsWith("/api/user/autonomous")) {`,
      classification: { kind: "owner-only", surface: "instance:control", sample: "/api/user/autonomous" },
    },
  ],
  "server-provider-routes.ts": [
    {
      guard: `if (method === "POST" && url === "/api/providers/switch") {`,
      classification: { kind: "owner-only", surface: "setup:write", sample: "/api/providers/switch" },
    },
    {
      // ROUND 14 #5: two spellings, one handler. Both samples are asserted below.
      guard: `if (method === "POST" && (url === "/api/models/refresh" || url === "/api/providers/models/refresh")) {`,
      classification: { kind: "owner-only", surface: "setup:write", sample: "/api/providers/models/refresh" },
    },
    {
      guard: `if (method === "POST" && url === "/api/routing/preset") {`,
      classification: { kind: "owner-only", surface: "setup:write", sample: "/api/routing/preset" },
    },
  ],
  "server-settings-routes.ts": [
    {
      guard: `if (url === "/api/budget/config" && method === "POST") {`,
      classification: { kind: "owner-only", surface: "setup:write", sample: "/api/budget/config" },
    },
    {
      guard: `if (url === "/api/settings/rate-limits" && method === "POST") {`,
      classification: { kind: "owner-only", surface: "setup:write", sample: "/api/settings/rate-limits" },
    },
    {
      guard: `if (method === "POST") {`,
      classification: { kind: "owner-only", surface: "setup:write", sample: "/api/settings/voice" },
    },
  ],
  "server-skills-routes.ts": [
    {
      guard: `if (url === "/api/skills/install" && method === "POST") {`,
      classification: { kind: "owner-only", surface: "setup:write", sample: "/api/skills/install" },
    },
    {
      guard: `if (enableMatch && method === "POST") {`,
      classification: { kind: "owner-only", surface: "setup:write", sample: "/api/skills/some-skill/enable" },
    },
    {
      guard: `if (disableMatch && method === "POST") {`,
      classification: { kind: "owner-only", surface: "setup:write", sample: "/api/skills/some-skill/disable" },
    },
  ],
  "server-system-routes.ts": [
    {
      guard: `if (url === "/api/deployment/check" && method === "POST") {`,
      classification: { kind: "owner-only", surface: "instance:control", sample: "/api/deployment/check" },
    },
  ],
  "server-vault-routes.ts": [
    {
      guard: `if (pathOnly === '/api/vaults' && method === 'POST') {`,
      classification: { kind: "owner-only", surface: "setup:write", sample: "/api/vaults" },
    },
    {
      guard: `if (deleteMatch && method === 'DELETE') {`,
      classification: { kind: "owner-only", surface: "setup:write", sample: "/api/vaults/v1" },
    },
    {
      guard: `if (regenCanvasMatch && method === 'POST') {`,
      classification: { kind: "owner-only", surface: "setup:write", sample: "/api/vaults/v1/canvas" },
    },
    {
      guard: `if (summarizeMatch && method === 'POST') {`,
      classification: { kind: "owner-only", surface: "setup:write", sample: "/api/vaults/v1/summarize" },
    },
    {
      guard: `if (op === 'search' && method === 'POST') {`,
      classification: { kind: "owner-only", surface: "setup:write", sample: "/api/vaults/v1/search" },
    },
    {
      guard: `if (op === 'sync' && method === 'POST') {`,
      classification: { kind: "owner-only", surface: "setup:write", sample: "/api/vaults/v1/sync" },
    },
  ],
  "server.ts": [
    {
      guard: `method !== "GET" &&`,
      classification: {
        kind: "self-guarded",
        why: "not a route: this is isMutableDashboardApi itself, the computation the central gate is driven from",
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
      "a mutating route with no decision written down. Add it to MUTATIONS with owner-only "
        + "(and its surface in instance-access.ts), own-identity (and the check in its handler), "
        + `or self-guarded (and why):\n${unclassified.join("\n")}`,
    ).toEqual([]);
    expect(
      stale,
      `MUTATIONS names a guard that no longer exists — re-read the route before deleting the row:\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  it("classifies each owner-only sample exactly as the live table does", () => {
    for (const [file, routes] of Object.entries(MUTATIONS)) {
      for (const route of routes) {
        if (route.classification.kind !== "owner-only") continue;
        expect(
          ownerOnlyProxySurface(route.classification.sample),
          `${file}: ${route.classification.sample}`,
        ).toBe(route.classification.surface);
      }
    }
  });

  it("keeps own-identity and self-guarded routes out of the owner-only table", () => {
    for (const [file, routes] of Object.entries(MUTATIONS)) {
      for (const route of routes) {
        if (route.classification.kind !== "own-identity") continue;
        // An own-identity route must NOT be owner-only: its handler scopes it to
        // the acting identity, and refusing a guest outright would take away its
        // own canvas, its own review, its own task.
        expect(
          ownerOnlyProxySurface(route.classification.sample),
          `${file}: ${route.classification.sample} — ${route.classification.why}`,
        ).toBeUndefined();
      }
    }
  });

  // ROUND 14 #5, stated as the invariant rather than the instance: a power that
  // answers on two URLs must be classified on both.
  it("classifies aliases of the same power identically", () => {
    const aliases: ReadonlyArray<readonly [string, string]> = [
      ["/api/models/refresh", "/api/providers/models/refresh"],
    ];
    for (const [left, right] of aliases) {
      expect(ownerOnlyProxySurface(left), `${left} vs ${right}`)
        .toBe(ownerOnlyProxySurface(right));
      expect(ownerOnlyProxySurface(left)).toBeDefined();
    }
  });
});
