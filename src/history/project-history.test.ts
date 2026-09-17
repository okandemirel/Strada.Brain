/**
 * Durable project history (improvement 6.6).
 *
 * The headline test is `survives a restart`: it writes a decision and a build,
 * CLOSES the database (that is the daemon restart / device change), reopens it
 * from the same path and asks the exit question — "show me that decision and
 * that build" — while a second identity must be shown nothing.
 */

import { describe, it, expect, afterAll } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { DaemonStorage } from "../daemon/daemon-storage.js";
import {
  ProjectHistoryStore,
  getProjectHistoryStore,
  isProjectHistoryEventId,
  newProjectHistoryEventId,
  normalizeProjectHistoryOwner,
} from "./project-history.js";
import { createTempDirTracker } from "../test-helpers.js";

const tmp = createTempDirTracker("project-history-test-");
afterAll(() => tmp.cleanup());

/** A daemon.db in a throwaway directory — never the real ~/.strada. */
function openStorage(dbPath: string): DaemonStorage {
  const storage = new DaemonStorage(dbPath);
  storage.initialize();
  return storage;
}

function freshDbPath(): string {
  return join(tmp.makeDir(), "daemon.db");
}

describe("ProjectHistoryStore — the exit criterion", () => {
  it("survives a restart: the decision and the build come back with their version and owner, and a second identity sees neither", () => {
    const dbPath = freshDbPath();

    // --- before the restart ---------------------------------------------------
    const first = openStorage(dbPath);
    const writer = new ProjectHistoryStore(first);
    const decision = writer.record({
      kind: "decision",
      projectId: "PixelFlow",
      summary: "Approved the shadow promotion of the jump-tuning artifact",
      owner: { scope: "user", userId: "alice", profileId: "profile-alice" },
      version: { campaignRevision: "rev-41", commitSha: "a1b2c3d4e5f6a7b8" },
      payload: { verdict: "ok", gate: "unity_playthrough", decidedBy: "alice" },
    });
    const delivery = writer.record({
      kind: "delivery",
      projectId: "PixelFlow",
      summary: "Build 41 delivered",
      owner: { scope: "user", userId: "alice" },
      version: { campaignRevision: "rev-41", commitSha: "A1B2C3D4E5F6A7B8" },
      payload: { verdict: "ok", placeholders: 3 },
    });
    expect(isProjectHistoryEventId(decision.id)).toBe(true);
    first.close();

    // --- after the restart (same path, brand new connection and store) --------
    const second = openStorage(dbPath);
    const reader = new ProjectHistoryStore(second);

    const mine = reader.list({ viewer: "alice", limit: 10 });
    expect(mine.map((e) => e.id)).toEqual([delivery.id, decision.id]);

    const recalledDecision = reader.get(decision.id, "alice");
    expect(recalledDecision).toBeDefined();
    expect(recalledDecision!.kind).toBe("decision");
    expect(recalledDecision!.summary).toContain("shadow promotion");
    expect(recalledDecision!.version).toEqual({ campaignRevision: "rev-41", commitSha: "a1b2c3d4e5f6a7b8" });
    expect(recalledDecision!.owner).toEqual({ scope: "user", userId: "alice", profileId: "profile-alice" });
    expect(recalledDecision!.payload).toEqual({ verdict: "ok", gate: "unity_playthrough", decidedBy: "alice" });
    expect(recalledDecision!.recordedAt).toBeGreaterThan(0);

    const recalledBuild = reader.get(delivery.id, "alice");
    expect(recalledBuild!.version.commitSha).toBe("a1b2c3d4e5f6a7b8");
    expect(recalledBuild!.version.campaignRevision).toBe("rev-41");

    // --- a second identity must be shown nothing ------------------------------
    expect(reader.list({ viewer: "bob", limit: 10 })).toEqual([]);
    expect(reader.get(decision.id, "bob")).toBeUndefined();
    expect(reader.get(delivery.id, "bob")).toBeUndefined();
    // And an anonymous read sees no user-owned event either.
    expect(reader.list({ limit: 10 })).toEqual([]);
    second.close();
  });
});

describe("ProjectHistoryStore — permission scope", () => {
  it("applies the owner gate in SQL BEFORE the limit, so another identity's events cannot eat the page", () => {
    const storage = openStorage(freshDbPath());
    const store = new ProjectHistoryStore(storage);
    const mine = store.record({
      kind: "milestone",
      projectId: "P",
      summary: "alice milestone",
      owner: { scope: "user", userId: "alice" },
    });
    // Five NEWER events belonging to someone else. A JS filter applied after a
    // LIMIT 3 would hand alice an empty list.
    for (let i = 0; i < 5; i++) {
      store.record({
        kind: "milestone",
        projectId: "P",
        summary: `bob milestone ${i}`,
        owner: { scope: "user", userId: "bob" },
      });
    }
    const page = store.list({ viewer: "alice", limit: 3 });
    expect(page.map((e) => e.id)).toEqual([mine.id]);
    storage.close();
  });

  it("shows a 'shared' event to everyone and an explicitly shared-with event only to the named identity", () => {
    const storage = openStorage(freshDbPath());
    const store = new ProjectHistoryStore(storage);
    const shared = store.record({
      kind: "milestone",
      projectId: "P",
      summary: "campaign shipped",
      owner: { scope: "shared" },
    });
    const sharedWithBob = store.record({
      kind: "decision",
      projectId: "P",
      summary: "alice let bob see this",
      owner: { scope: "user", userId: "alice", sharedWith: ["bob"] },
    });

    expect(store.list({ viewer: "carol" }).map((e) => e.id)).toEqual([shared.id]);
    expect(store.list({ viewer: "bob" }).map((e) => e.id)).toEqual([sharedWithBob.id, shared.id]);
    expect(store.get(sharedWithBob.id, "bob")).toBeDefined();
    expect(store.get(sharedWithBob.id, "carol")).toBeUndefined();
    // A prefix of a shared-with identity is not that identity.
    expect(store.get(sharedWithBob.id, "bo")).toBeUndefined();
    storage.close();
  });

  it("matches the portal's profileId as well as the userId", () => {
    const storage = openStorage(freshDbPath());
    const store = new ProjectHistoryStore(storage);
    const event = store.record({
      kind: "decision",
      projectId: "P",
      summary: "decided in the portal",
      owner: { scope: "user", profileId: "profile-7" },
    });
    expect(store.get(event.id, "profile-7")).toBeDefined();
    expect(store.get(event.id, "profile-8")).toBeUndefined();
    storage.close();
  });

  it("stores an unattributable event but shows it to NOBODY", () => {
    const storage = openStorage(freshDbPath());
    const store = new ProjectHistoryStore(storage);
    // scope 'user' with no identity at all: a background writer with no session.
    const orphan = store.record({
      kind: "decision",
      projectId: "P",
      summary: "somebody approved something",
      owner: { scope: "user", sharedWith: ["bob"] },
    });
    expect(orphan.owner).toEqual({ scope: "unknown" });

    // It IS on disk...
    const raw = storage.getDatabase()
      .prepare("SELECT owner_scope FROM project_history WHERE id = ?")
      .get(orphan.id) as { owner_scope: string } | undefined;
    expect(raw?.owner_scope).toBe("unknown");

    // ...and it reaches nobody: not the writer, not a bystander, not anonymous.
    expect(store.get(orphan.id, "alice")).toBeUndefined();
    expect(store.get(orphan.id, "bob")).toBeUndefined();
    expect(store.get(orphan.id)).toBeUndefined();
    expect(store.list({ viewer: "alice" })).toEqual([]);
    expect(store.list({})).toEqual([]);
    storage.close();
  });

  it("filters by project and kind alongside the owner gate", () => {
    const storage = openStorage(freshDbPath());
    const store = new ProjectHistoryStore(storage);
    const build = store.record({
      kind: "delivery",
      projectId: "alpha",
      summary: "alpha build",
      owner: { scope: "user", userId: "alice" },
      version: { commitSha: "abcdef1234567" },
    });
    store.record({
      kind: "delivery",
      projectId: "beta",
      summary: "beta build",
      owner: { scope: "user", userId: "alice" },
      version: { commitSha: "abcdef1234567" },
    });
    store.record({
      kind: "milestone",
      projectId: "alpha",
      summary: "alpha milestone",
      owner: { scope: "user", userId: "alice" },
    });
    const page = store.list({ viewer: "alice", projectId: "alpha", kinds: ["delivery"] });
    expect(page.map((e) => e.id)).toEqual([build.id]);
    storage.close();
  });
});

describe("ProjectHistoryStore — append-only and monotonic", () => {
  it("never overwrites a recorded event", () => {
    const storage = openStorage(freshDbPath());
    const store = new ProjectHistoryStore(storage);
    const first = store.record({
      kind: "decision",
      projectId: "P",
      summary: "the original",
      owner: { scope: "user", userId: "alice" },
      payload: { verdict: "ok" },
    });
    expect(() =>
      store.record({
        kind: "decision",
        projectId: "P",
        summary: "a rewrite",
        owner: { scope: "user", userId: "alice" },
        payload: { verdict: "fail" },
        id: first.id,
      }),
    ).toThrow(/append-only/);
    const kept = store.get(first.id, "alice");
    expect(kept!.summary).toBe("the original");
    expect(kept!.payload).toEqual({ verdict: "ok" });
    storage.close();
  });

  it("keeps time moving forward when the wall clock goes backwards, across a restart too", () => {
    const dbPath = freshDbPath();
    const first = openStorage(dbPath);
    const writer = new ProjectHistoryStore(first);
    const anchor = writer.record({
      kind: "milestone",
      projectId: "P",
      summary: "anchor",
      owner: { scope: "shared" },
      recordedAt: 2_000_000,
    });
    const afterStep = writer.record({
      kind: "milestone",
      projectId: "P",
      summary: "clock stepped back",
      owner: { scope: "shared" },
      recordedAt: 1_000,
    });
    expect(afterStep.recordedAt).toBeGreaterThan(anchor.recordedAt);
    first.close();

    // A fresh store after the restart must re-learn the watermark from the table.
    const second = openStorage(dbPath);
    const reopened = new ProjectHistoryStore(second);
    const afterRestart = reopened.record({
      kind: "milestone",
      projectId: "P",
      summary: "recorded after the restart with a stale clock",
      owner: { scope: "shared" },
      recordedAt: 5,
    });
    expect(afterRestart.recordedAt).toBeGreaterThan(afterStep.recordedAt);
    expect(reopened.list({ viewer: "anyone" })[0]!.id).toBe(afterRestart.id);
    second.close();
  });
});

describe("ProjectHistoryStore — validation", () => {
  it("refuses a delivery that names no version", () => {
    const storage = openStorage(freshDbPath());
    const store = new ProjectHistoryStore(storage);
    expect(() =>
      store.record({
        kind: "delivery",
        projectId: "P",
        summary: "a build with no build",
        owner: { scope: "shared" },
      }),
    ).toThrow(/must name the version/);
    // A decision may legitimately carry no version.
    expect(() =>
      store.record({ kind: "decision", projectId: "P", summary: "ok", owner: { scope: "shared" } }),
    ).not.toThrow();
    storage.close();
  });

  it("refuses junk: unknown kind, empty project, empty summary, a non-sha, a comma in an identity", () => {
    const storage = openStorage(freshDbPath());
    const store = new ProjectHistoryStore(storage);
    const base = { projectId: "P", summary: "s", owner: { scope: "shared" as const } };
    expect(() => store.record({ ...base, kind: "gossip" as never })).toThrow(/Unknown project history kind/);
    expect(() => store.record({ ...base, kind: "decision", projectId: "  " })).toThrow(/projectId is required/);
    expect(() => store.record({ ...base, kind: "decision", summary: " " })).toThrow(/summary is required/);
    expect(() =>
      store.record({ ...base, kind: "decision", version: { commitSha: "not-a-sha" } }),
    ).toThrow(/is not a commit sha/);
    expect(() =>
      store.record({ ...base, kind: "decision", owner: { scope: "user", userId: "a,b" } }),
    ).toThrow(/must not contain a comma/);
    expect(() => store.record({ ...base, kind: "decision", id: "nope" })).toThrow(/not a project history event id/);
    storage.close();
  });

  it("validates an event id without touching storage", () => {
    expect(isProjectHistoryEventId(newProjectHistoryEventId("delivery"))).toBe(true);
    expect(isProjectHistoryEventId("hist_delivery_abc_1234")).toBe(false);
    expect(isProjectHistoryEventId("../../etc/passwd")).toBe(false);
    expect(isProjectHistoryEventId(42)).toBe(false);
  });

  it("normalizes ownership: an identity-less 'user' owner becomes 'unknown'", () => {
    expect(normalizeProjectHistoryOwner({ scope: "user", userId: "  " })).toEqual({ scope: "unknown" });
    expect(normalizeProjectHistoryOwner({ scope: "user", userId: " alice " })).toEqual({
      scope: "user",
      userId: "alice",
    });
    expect(() => normalizeProjectHistoryOwner({ scope: "nobody" as never })).toThrow(/owner.scope/);
  });

  it("shares one store — and one monotonic clock — per storage connection", () => {
    const storage = openStorage(freshDbPath());
    expect(getProjectHistoryStore(storage)).toBe(getProjectHistoryStore(storage));
    storage.close();
  });
});

describe("daemon.db migration", () => {
  it("adds the history columns to a database that already holds an older project_history table", () => {
    const dbPath = freshDbPath();
    // A daemon.db written by an earlier shape of this feature: the table exists
    // but knows nothing about ownership or versions.
    const legacy = new Database(dbPath);
    legacy.exec(
      `CREATE TABLE project_history (
         id TEXT PRIMARY KEY,
         kind TEXT NOT NULL,
         project_id TEXT NOT NULL,
         summary TEXT NOT NULL,
         payload TEXT NOT NULL,
         recorded_at INTEGER NOT NULL
       )`,
    );
    legacy.prepare(
      "INSERT INTO project_history (id, kind, project_id, summary, payload, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("hist_decision_kfz1a2_deadbeef", "decision", "P", "an old row", "{}", 1234);
    legacy.close();

    const storage = openStorage(dbPath);
    const columns = (storage.getDatabase().prepare("PRAGMA table_info(project_history)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(columns).toEqual(
      expect.arrayContaining(["owner_scope", "owner_user_id", "owner_profile_id", "shared_with", "campaign_revision", "commit_sha"]),
    );

    // The migrated database accepts a versioned, owned row...
    const store = new ProjectHistoryStore(storage);
    const event = store.record({
      kind: "delivery",
      projectId: "P",
      summary: "post-migration build",
      owner: { scope: "user", userId: "alice" },
      version: { commitSha: "0123456789abc" },
    });
    expect(store.get(event.id, "alice")!.version.commitSha).toBe("0123456789abc");
    // ...and the pre-existing row, which nobody can be attributed to, reaches nobody.
    expect(store.get("hist_decision_kfz1a2_deadbeef", "alice")).toBeUndefined();
    // The monotonic clock respects what the old table already held.
    expect(event.recordedAt).toBeGreaterThan(1234);
    storage.close();
  });
});

/**
 * Codex round 13 #6 — AN ID THIS MODULE MINTS MUST PASS THIS MODULE'S VALIDATOR.
 *
 * The id is `hist_<kind>_<base36 millis>_<8 hex>` and the reader's regex demands
 * at least SIX characters for the timestamp component, while the writer emitted
 * `now.toString(36)` unpadded. Any recordedAt below 36^5 (60,466,176 ms — an
 * epoch clock, a seeded fixture, a device whose clock has not been set) minted a
 * five-character component: the row was written and LISTED fine, but `get(id)`
 * returned nothing and the HTTP lookup answered 400 for an id the writer itself
 * had just handed out. Row visible, row unreachable.
 *
 * Property-style over magnitudes rather than one hand-picked value: the bug is a
 * WIDTH, so the test has to cross the width boundaries.
 */
describe("project history ids round-trip their own validator (round 13 #6)", () => {
  const magnitudes = [
    1,
    2_000_000,
    60_466_175,      // 36^5 - 1: the last value that used to be five characters
    60_466_176,      // 36^5
    1_700_000_000_000, // a real wall clock
    4_000_000_000_000_000, // far future (year ~128,700)
  ];

  it("mints ids that isProjectHistoryEventId accepts, at every magnitude", () => {
    for (const recordedAt of magnitudes) {
      for (const kind of ["decision", "delivery", "milestone"] as const) {
        const id = newProjectHistoryEventId(kind, recordedAt);
        expect(isProjectHistoryEventId(id), `${kind} @ ${recordedAt} → ${id}`).toBe(true);
      }
    }
  });

  it("stores and reads back an event recorded at any of those clocks", () => {
    for (const recordedAt of magnitudes) {
      const storage = openStorage(freshDbPath());
      const store = new ProjectHistoryStore(storage);
      const event = store.record({
        kind: "decision",
        projectId: "PixelFlow",
        summary: `recorded at ${recordedAt}`,
        owner: { scope: "user", userId: "alice" },
        payload: {},
        recordedAt,
      });

      expect(isProjectHistoryEventId(event.id), `${recordedAt} → ${event.id}`).toBe(true);
      // Listed AND reachable: the defect showed up as exactly this asymmetry.
      expect(store.list({ viewer: "alice" }).map((e) => e.id)).toContain(event.id);
      expect(store.get(event.id, "alice")?.summary).toBe(`recorded at ${recordedAt}`);
      storage.close();
    }
  });

  it("ids stay sortable by their timestamp component, which is what padding buys", () => {
    const earlier = newProjectHistoryEventId("decision", 2_000_000);
    const later = newProjectHistoryEventId("decision", 1_700_000_000_000);
    const stamp = (id: string) => id.split("_")[2]!;
    expect(stamp(earlier).length).toBe(stamp(later).length);
    expect(stamp(earlier) < stamp(later)).toBe(true);
  });
});
