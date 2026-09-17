/**
 * GET /api/workspace/history[/:id] — the durable-history read surface (6.6).
 *
 * These tests drive the handler directly with the shared mock-HTTP harness, over
 * a real DaemonStorage in a throwaway directory (never the real ~/.strada).
 *
 * ROUND 13 #4 CHANGED HOW THE CALLER IS NAMED. The reading identity used to come
 * from `?viewer=`, which is a public value: naming the owner read the owner's
 * private history. It now comes from the VERIFIED profile pair, so every test
 * here presents headers, and the impersonation attempt has its own test.
 */

import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { handleProjectHistoryRoutes, PROJECT_HISTORY_ROUTE_PREFIX } from "./project-history-routes.js";
import { createMockReq, createMockRes, responseJson } from "./test-support/mock-http.js";
import { DaemonStorage } from "../daemon/daemon-storage.js";
import { ProjectHistoryStore, type ProjectHistoryEvent } from "../history/project-history.js";
import { createTempDirTracker } from "../test-helpers.js";
import { setInstanceIdentityStore } from "../channels/web/instance-authorization.js";
import type { RouteContext } from "./server-types.js";

vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  const stub = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { ...actual, getLogger: () => stub, getLoggerSafe: () => stub };
});

const tmp = createTempDirTracker("project-history-routes-");
afterAll(() => tmp.cleanup());

function makeCtx(overrides: Partial<RouteContext> = {}): RouteContext {
  return { ...overrides } as unknown as RouteContext;
}

interface Fixture {
  storage: DaemonStorage;
  ctx: RouteContext;
  alice: ProjectHistoryEvent;
  build: ProjectHistoryEvent;
  bob: ProjectHistoryEvent;
}

/** A storage holding one alice decision, one alice build and one bob milestone. */
function fixture(): Fixture {
  const storage = new DaemonStorage(join(tmp.makeDir(), "daemon.db"));
  storage.initialize();
  const store = new ProjectHistoryStore(storage);
  const alice = store.record({
    kind: "decision",
    projectId: "PixelFlow",
    summary: "Approved build 41",
    owner: { scope: "user", userId: "alice" },
    version: { campaignRevision: "rev-41", commitSha: "a1b2c3d4e5f6" },
    payload: { verdict: "ok" },
  });
  const build = store.record({
    kind: "delivery",
    projectId: "PixelFlow",
    summary: "Build 41 delivered",
    owner: { scope: "user", userId: "alice" },
    version: { campaignRevision: "rev-41", commitSha: "a1b2c3d4e5f6" },
  });
  const bob = store.record({
    kind: "milestone",
    projectId: "PixelFlow",
    summary: "bob's milestone",
    owner: { scope: "user", userId: "bob" },
  });
  return { storage, ctx: makeCtx({ daemonStorage: storage }), alice, build, bob };
}

/**
 * The identity store the instance keeps, as this surface needs it: it VERIFIES a
 * pair. `alice` is the instance owner here; `bob` and `profile-7` are guests.
 */
function identities() {
  const issued = ["alice", "bob", "profile-7", "profile-8"];
  return {
    verify: (profileId: string, token: string) => issued.includes(profileId) && token === `token-${profileId}`,
    ownerProfileId: () => "alice",
    has: (profileId: string) => issued.includes(profileId),
    count: () => issued.length,
  };
}

/** The headers a browser holding `profileId` sends, and the portal now attaches. */
const as = (profileId: string): Record<string, string> => ({
  "x-strada-profile-id": profileId,
  "x-strada-profile-token": `token-${profileId}`,
});

beforeEach(() => setInstanceIdentityStore(identities()));
afterEach(() => setInstanceIdentityStore(null));

function get(
  url: string,
  ctx: RouteContext,
  headers: Record<string, string> = {},
): { handled: boolean; res: ReturnType<typeof createMockRes> } {
  const res = createMockRes();
  const req = createMockReq();
  (req as unknown as { headers: Record<string, string> }).headers = headers;
  const handled = handleProjectHistoryRoutes(url, "GET", req, res, ctx);
  return { handled, res };
}

describe("handleProjectHistoryRoutes — routing", () => {
  it("declines URLs that are not the history surface", () => {
    const res = createMockRes();
    for (const url of ["/api/workspace/tree", "/api/workspace/historyx", "/api/canvas", "/api/workspace"]) {
      expect(handleProjectHistoryRoutes(url, "GET", createMockReq(), res, makeCtx())).toBe(false);
    }
    expect(res.end).not.toHaveBeenCalled();
  });

  it("is read-only: any other method is 405", () => {
    const f = fixture();
    for (const method of ["POST", "DELETE", "PUT"]) {
      const res = createMockRes();
      expect(handleProjectHistoryRoutes(PROJECT_HISTORY_ROUTE_PREFIX, method, createMockReq(), res, f.ctx)).toBe(true);
      expect(res.statusCode).toBe(405);
    }
    f.storage.close();
  });

  it("404s a deeper path under the prefix", () => {
    const f = fixture();
    const { res } = get(`${PROJECT_HISTORY_ROUTE_PREFIX}/${f.alice.id}/payload`, f.ctx);
    expect(res.statusCode).toBe(404);
    f.storage.close();
  });

  it("answers 503 when the daemon storage is not there", () => {
    const { res } = get(PROJECT_HISTORY_ROUTE_PREFIX, makeCtx());
    expect(res.statusCode).toBe(503);
    expect(String(responseJson(res).error)).toMatch(/unavailable/i);
  });
});

describe("handleProjectHistoryRoutes — the newest events for the caller", () => {
  it("returns the caller's own events, newest first, and nobody else's", () => {
    const f = fixture();
    const { handled, res } = get(`${PROJECT_HISTORY_ROUTE_PREFIX}?limit=10`, f.ctx, as("alice"));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = responseJson(res) as { viewer: string; count: number; events: ProjectHistoryEvent[] };
    expect(body.viewer).toBe("alice");
    expect(body.events.map((e) => e.id)).toEqual([f.build.id, f.alice.id]);
    expect(body.count).toBe(2);
    expect(body.events[1]!.version).toEqual({ campaignRevision: "rev-41", commitSha: "a1b2c3d4e5f6" });
    expect(body.events[1]!.owner).toEqual({ scope: "user", userId: "alice" });
    expect(res.headers["Cache-Control"]).toContain("no-store");

    const asBob = get(PROJECT_HISTORY_ROUTE_PREFIX, f.ctx, as("bob"));
    expect((responseJson(asBob.res) as { events: ProjectHistoryEvent[] }).events.map((e) => e.id)).toEqual([f.bob.id]);
    f.storage.close();
  });

  it("accepts the portal's profileId as the viewer alias", () => {
    const storage = new DaemonStorage(join(tmp.makeDir(), "daemon.db"));
    storage.initialize();
    const event = new ProjectHistoryStore(storage).record({
      kind: "decision",
      projectId: "P",
      summary: "decided in the portal",
      owner: { scope: "user", profileId: "profile-7" },
    });
    const ctx = makeCtx({ daemonStorage: storage });
    const mine = get(PROJECT_HISTORY_ROUTE_PREFIX, ctx, as("profile-7"));
    expect((responseJson(mine.res) as { events: ProjectHistoryEvent[] }).events.map((e) => e.id)).toEqual([event.id]);
    const other = get(PROJECT_HISTORY_ROUTE_PREFIX, ctx, as("profile-8"));
    expect((responseJson(other.res) as { events: ProjectHistoryEvent[] }).events).toEqual([]);
    storage.close();
  });

  it("filters by kind and project, and refuses an unknown kind", () => {
    const f = fixture();
    const ok = get(`${PROJECT_HISTORY_ROUTE_PREFIX}?kind=delivery&project=PixelFlow`, f.ctx, as("alice"));
    expect((responseJson(ok.res) as { events: ProjectHistoryEvent[] }).events.map((e) => e.id)).toEqual([f.build.id]);

    const otherProject = get(`${PROJECT_HISTORY_ROUTE_PREFIX}?project=SomethingElse`, f.ctx, as("alice"));
    expect((responseJson(otherProject.res) as { events: ProjectHistoryEvent[] }).events).toEqual([]);

    const bad = get(`${PROJECT_HISTORY_ROUTE_PREFIX}?kind=gossip`, f.ctx, as("alice"));
    expect(bad.res.statusCode).toBe(400);
    expect(String(responseJson(bad.res).error)).toMatch(/Unknown history kind/);
    f.storage.close();
  });

  it("clamps the limit instead of trusting it", () => {
    const f = fixture();
    const body = (url: string) => responseJson(get(url, f.ctx, as("alice")).res) as { limit: number };
    expect(body(PROJECT_HISTORY_ROUTE_PREFIX).limit).toBe(50);
    expect(body(`${PROJECT_HISTORY_ROUTE_PREFIX}?limit=1000000`).limit).toBe(500);
    expect(body(`${PROJECT_HISTORY_ROUTE_PREFIX}?limit=-3`).limit).toBe(50);
    expect(body(`${PROJECT_HISTORY_ROUTE_PREFIX}?limit=nonsense`).limit).toBe(50);
    f.storage.close();
  });

  // ── ROUND 13 #4: the query string is not a principal ──────────────────────
  //
  // THE DEFECT. `?viewer=` WAS the SQL principal, and a profile id is public —
  // the server sends it to the browser and the browser keeps it in localStorage.
  // So `GET /api/workspace/history?viewer=<owner>` read the owner's private
  // history from any caller the transport let through, on the portal proxy and on
  // the dashboard port alike.
  it("refuses a viewer named in the query string, and leaks nothing", () => {
    const f = fixture();
    for (const url of [
      `${PROJECT_HISTORY_ROUTE_PREFIX}?viewer=alice`,
      `${PROJECT_HISTORY_ROUTE_PREFIX}?profileId=alice`,
      `${PROJECT_HISTORY_ROUTE_PREFIX}?userId=alice`,
      `${PROJECT_HISTORY_ROUTE_PREFIX}/${f.alice.id}?viewer=alice`,
    ]) {
      const { res } = get(url, f.ctx);
      expect(res.statusCode, url).toBe(403);
      expect(res.body, url).not.toContain("Approved build 41");
    }
    f.storage.close();
  });

  it("refuses a GUEST naming the owner, even though the guest is verified", () => {
    const f = fixture();
    const { res } = get(`${PROJECT_HISTORY_ROUTE_PREFIX}?viewer=alice`, f.ctx, as("bob"));
    expect(res.statusCode).toBe(403);
    expect(String(responseJson(res).code)).toBe("deny:claimed-viewer");
    expect(res.body).not.toContain("Approved build 41");
    f.storage.close();
  });

  it("allows a viewer parameter that names the caller's OWN verified identity", () => {
    const f = fixture();
    const { res } = get(`${PROJECT_HISTORY_ROUTE_PREFIX}?viewer=alice`, f.ctx, as("alice"));
    expect(res.statusCode).toBe(200);
    expect((responseJson(res) as { events: ProjectHistoryEvent[] }).events.map((e) => e.id))
      .toEqual([f.build.id, f.alice.id]);
    f.storage.close();
  });

  it("gives a caller that proves no identity the shared rows only — not a 500, not everything", () => {
    const f = fixture();
    const { res } = get(PROJECT_HISTORY_ROUTE_PREFIX, f.ctx);
    expect(res.statusCode).toBe(200);
    const body = responseJson(res) as { viewer: string | null; events: ProjectHistoryEvent[] };
    expect(body.viewer).toBeNull();
    expect(body.events).toEqual([]);
    f.storage.close();
  });

  it("a claimed id whose token does not verify is nobody", () => {
    const f = fixture();
    const { res } = get(PROJECT_HISTORY_ROUTE_PREFIX, f.ctx, {
      "x-strada-profile-id": "alice",
      "x-strada-profile-token": "guessed",
    });
    expect(res.statusCode).toBe(200);
    expect((responseJson(res) as { events: ProjectHistoryEvent[] }).events).toEqual([]);
    f.storage.close();
  });

  it("answers 503 when the identity state cannot be read at all (round 13 #14)", () => {
    const f = fixture();
    const boom = (): never => { throw new Error("SQLITE_CORRUPT: database disk image is malformed"); };
    setInstanceIdentityStore({ verify: boom, ownerProfileId: boom, has: boom, count: boom });
    const { res } = get(PROJECT_HISTORY_ROUTE_PREFIX, f.ctx, as("alice"));
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("Approved build 41");
    f.storage.close();
  });
});

describe("handleProjectHistoryRoutes — lookup by event id", () => {
  it("returns the decision and the build by id for their owner", () => {
    const f = fixture();
    const decision = get(`${PROJECT_HISTORY_ROUTE_PREFIX}/${f.alice.id}`, f.ctx, as("alice"));
    expect(decision.res.statusCode).toBe(200);
    const event = (responseJson(decision.res) as { event: ProjectHistoryEvent }).event;
    expect(event.id).toBe(f.alice.id);
    expect(event.summary).toBe("Approved build 41");
    expect(event.version.commitSha).toBe("a1b2c3d4e5f6");

    const build = get(`${PROJECT_HISTORY_ROUTE_PREFIX}/${f.build.id}`, f.ctx, as("alice"));
    expect((responseJson(build.res) as { event: ProjectHistoryEvent }).event.kind).toBe("delivery");
    f.storage.close();
  });

  it("404s another identity's event, with the same answer as a missing one", () => {
    const f = fixture();
    const notMine = get(`${PROJECT_HISTORY_ROUTE_PREFIX}/${f.alice.id}`, f.ctx, as("bob"));
    expect(notMine.res.statusCode).toBe(404);
    const missing = get(`${PROJECT_HISTORY_ROUTE_PREFIX}/hist_decision_zzzzzz_00000000`, f.ctx, as("alice"));
    expect(missing.res.statusCode).toBe(404);
    // Identical shape, so a 404 never confirms that somebody else's event exists.
    expect(String(responseJson(notMine.res).error)).toBe(`No project history event ${f.alice.id} for this caller`);
    expect(String(responseJson(missing.res).error)).toBe(
      "No project history event hist_decision_zzzzzz_00000000 for this caller",
    );
    f.storage.close();
  });

  it("refuses a malformed id BEFORE touching storage", () => {
    const f = fixture();
    const spy = vi.spyOn(f.storage, "getProjectHistoryRow");
    for (const id of ["nope", "hist_decision_x_1", "..%2F..%2Fetc%2Fpasswd", "hist_gossip_kfz1a2_deadbeef", "%E0%A4%A"]) {
      const { res } = get(`${PROJECT_HISTORY_ROUTE_PREFIX}/${id}`, f.ctx, as("alice"));
      expect(res.statusCode).toBe(400);
      expect(String(responseJson(res).error)).toMatch(/not a project history event id/i);
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    f.storage.close();
  });

  it("reports a storage failure as a 500 instead of an empty answer", () => {
    const f = fixture();
    vi.spyOn(f.storage, "listProjectHistoryRows").mockImplementation(() => {
      throw new Error("database is locked");
    });
    const { res } = get(PROJECT_HISTORY_ROUTE_PREFIX, f.ctx, as("alice"));
    expect(res.statusCode).toBe(500);
    vi.restoreAllMocks();
    f.storage.close();
  });
});
