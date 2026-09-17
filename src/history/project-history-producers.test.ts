/**
 * THE PRODUCERS (plan 6.6, second half).
 *
 * The table, the gate and the routes were groundwork; these tests drive the REAL
 * producers — the daemon's approval queue and the campaign manager's seam — and
 * assert the row comes back to its owner, does NOT come back to a second
 * identity, and that a recorder which throws never takes the producer down.
 */

import { describe, it, expect, vi, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DaemonStorage } from "../daemon/daemon-storage.js";
import { ApprovalQueue } from "../daemon/security/approval-queue.js";
import { ProjectHistoryStore, type ProjectHistoryEvent } from "./project-history.js";
import {
  createProjectHistoryRecorder,
  safeRecordProjectHistory,
  type ProjectHistoryRecorder,
} from "./project-history-recorder.js";
import { createTempDirTracker } from "../test-helpers.js";

vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  const stub = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { ...actual, getLogger: () => stub, getLoggerSafe: () => stub };
});

const tmp = createTempDirTracker("project-history-producers-");
afterAll(() => tmp.cleanup());

function openStorage(): DaemonStorage {
  const storage = new DaemonStorage(join(tmp.makeDir(), "daemon.db"));
  storage.initialize();
  return storage;
}

// =============================================================================
// THE RECORDER SEAM
// =============================================================================

describe("createProjectHistoryRecorder", () => {
  it("records against the project it was built for and returns the stored event", () => {
    const storage = openStorage();
    const record = createProjectHistoryRecorder(storage, { projectId: "PixelFlow" });
    const event = record({
      kind: "milestone",
      summary: "art pass done",
      owner: { userId: "alice" },
    });
    expect(event!.projectId).toBe("PixelFlow");
    const store = new ProjectHistoryStore(storage);
    expect(store.get(event!.id, "alice")).toBeDefined();
    expect(store.get(event!.id, "bob")).toBeUndefined();
    storage.close();
  });

  it("NEVER widens reach: no identity means 'unknown', not 'shared'", () => {
    const storage = openStorage();
    const record = createProjectHistoryRecorder(storage, { projectId: "P" });
    const orphan = record({ kind: "decision", summary: "somebody decided something" });
    expect(orphan!.owner).toEqual({ scope: "unknown" });
    const store = new ProjectHistoryStore(storage);
    expect(store.get(orphan!.id, "alice")).toBeUndefined();
    expect(store.list({})).toEqual([]);

    // 'shared' happens only when the producer says so.
    const announced = record({ kind: "milestone", summary: "campaign shipped", owner: { shared: true } });
    expect(announced!.owner.scope).toBe("shared");
    expect(store.get(announced!.id, "anyone")).toBeDefined();
    storage.close();
  });

  it("records a fact once: the same dedupeKey is refused, not duplicated — and the refusal survives a restart", () => {
    const dbPath = join(tmp.makeDir(), "daemon.db");
    const first = new DaemonStorage(dbPath);
    first.initialize();
    const record = createProjectHistoryRecorder(first, { projectId: "P" });
    const fact = { kind: "milestone" as const, summary: "Sprint A — green", owner: { userId: "alice" }, dedupeKey: "c1:m1:green:1" };
    const once = record(fact);
    expect(once).toBeDefined();
    expect(record(fact)).toBeUndefined();
    expect(new ProjectHistoryStore(first).list({ viewer: "alice" })).toHaveLength(1);
    first.close();

    // A NEW process — a new connection, a new in-memory anything — must not be
    // able to write the same fact a second time.
    const second = new DaemonStorage(dbPath);
    second.initialize();
    expect(createProjectHistoryRecorder(second, { projectId: "P" })(fact)).toBeUndefined();
    const store = new ProjectHistoryStore(second);
    expect(store.list({ viewer: "alice" }).map((e) => e.id)).toEqual([once!.id]);
    // A different outcome of the same milestone is a different fact.
    expect(record).toBeDefined();
    expect(
      createProjectHistoryRecorder(second, { projectId: "P" })({ ...fact, summary: "Sprint A — failed", dedupeKey: "c1:m1:failed:2" }),
    ).toBeDefined();
    expect(store.list({ viewer: "alice" })).toHaveLength(2);
    second.close();
  });

  it("swallows a storage failure instead of failing its caller", () => {
    const storage = openStorage();
    const record = createProjectHistoryRecorder(storage, { projectId: "P" });
    storage.close(); // every write now throws "not initialized"
    expect(() => record({ kind: "milestone", summary: "after the close", owner: { shared: true } })).not.toThrow();
    expect(record({ kind: "milestone", summary: "after the close", owner: { shared: true } })).toBeUndefined();
  });

  it("swallows a rejected event (a delivery with no version) instead of failing its caller", () => {
    const storage = openStorage();
    const record = createProjectHistoryRecorder(storage, { projectId: "P" });
    expect(record({ kind: "delivery", summary: "a build with no build", owner: { shared: true } })).toBeUndefined();
    expect(new ProjectHistoryStore(storage).list({ viewer: "anyone" })).toEqual([]);
    storage.close();
  });
});

describe("safeRecordProjectHistory", () => {
  it("absorbs a recorder that throws, and does nothing at all when none is wired", () => {
    const thrower: ProjectHistoryRecorder = () => {
      throw new Error("injected recorder is broken");
    };
    expect(() => safeRecordProjectHistory(thrower, { kind: "decision", summary: "x" })).not.toThrow();
    expect(safeRecordProjectHistory(thrower, { kind: "decision", summary: "x" })).toBeUndefined();
    expect(safeRecordProjectHistory(undefined, { kind: "decision", summary: "x" })).toBeUndefined();
  });
});

// =============================================================================
// PRODUCER: the daemon's approval queue -> a `decision`
// =============================================================================

describe("ApprovalQueue records decisions in the durable history", () => {
  function queueWithHistory(): { queue: ApprovalQueue; storage: DaemonStorage; store: ProjectHistoryStore } {
    const storage = openStorage();
    const queue = new ApprovalQueue(storage, 30);
    queue.setProjectHistoryRecorder(createProjectHistoryRecorder(storage, { projectId: "PixelFlow" }));
    return { queue, storage, store: new ProjectHistoryStore(storage) };
  }

  it("records an approval against the person who approved it, and nobody else can read it", () => {
    const { queue, storage, store } = queueWithHistory();
    const entry = queue.enqueue("deploy", { target: "prod" }, "nightly");
    expect(queue.approve(entry.id, "alice").applied).toBe(true);

    const mine = store.list({ viewer: "alice" });
    expect(mine).toHaveLength(1);
    expect(mine[0]!.kind).toBe("decision");
    expect(mine[0]!.summary).toBe("Approved deploy");
    expect(mine[0]!.owner).toEqual({ scope: "user", userId: "alice" });
    expect(mine[0]!.payload).toMatchObject({
      approvalId: entry.id,
      toolName: "deploy",
      decision: "approved",
      decidedBy: "alice",
      triggerName: "nightly",
    });

    expect(store.list({ viewer: "bob" })).toEqual([]);
    expect(store.get(mine[0]!.id, "bob")).toBeUndefined();
    storage.close();
  });

  it("records a denial too, with the denier as the owner", () => {
    const { queue, storage, store } = queueWithHistory();
    const entry = queue.enqueue("rm-rf", {});
    queue.deny(entry.id, "bob");
    const bobs = store.list({ viewer: "bob" });
    expect(bobs.map((e) => e.summary)).toEqual(["Denied rm-rf"]);
    expect(store.list({ viewer: "alice" })).toEqual([]);
    storage.close();
  });

  it("records a timeout expiry as an unattributed decision — it reaches nobody", () => {
    const { queue, storage, store } = queueWithHistory();
    const entry = queue.enqueue("deploy", { target: "prod" }, "nightly");
    // Force the entry past its expiry without waiting 30 minutes.
    storage.getDatabase().prepare("UPDATE approval_queue SET expires_at = ? WHERE id = ?").run(1, entry.id);
    queue.expireStale();

    expect(queue.getById(entry.id)!.status).toBe("expired");
    const rows = storage.getDatabase()
      .prepare("SELECT owner_scope, summary FROM project_history")
      .all() as Array<{ owner_scope: string; summary: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner_scope).toBe("unknown");
    expect(rows[0]!.summary).toContain("Expired without a decision");
    // Nobody — not a bystander, not an anonymous caller — can read it.
    expect(store.list({ viewer: "alice" })).toEqual([]);
    expect(store.list({})).toEqual([]);
    storage.close();
  });

  it("does not record a decision that did not land", () => {
    const { queue, storage, store } = queueWithHistory();
    const entry = queue.enqueue("deploy", {});
    queue.deny(entry.id, "alice");
    // A second decision on a settled entry must not land — and must not be history.
    expect(queue.approve(entry.id, "alice").applied).toBe(false);
    expect(store.list({ viewer: "alice" }).map((e) => e.summary)).toEqual(["Denied deploy"]);
    expect(queue.approve("no-such-id", "alice").applied).toBe(false);
    expect(store.list({ viewer: "alice" })).toHaveLength(1);
    storage.close();
  });

  it("still approves when the history recorder throws", () => {
    const storage = openStorage();
    const queue = new ApprovalQueue(storage, 30);
    queue.setProjectHistoryRecorder(() => {
      throw new Error("history is on fire");
    });
    const entry = queue.enqueue("deploy", {});
    expect(() => queue.approve(entry.id, "alice")).not.toThrow();
    expect(queue.getById(entry.id)!.status).toBe("approved");
    expect(queue.getAuditLog(10).map((a) => a.decision)).toEqual(["approved"]);
    storage.close();
  });

  it("records nothing at all when no recorder is wired", () => {
    const storage = openStorage();
    const queue = new ApprovalQueue(storage, 30);
    const entry = queue.enqueue("deploy", {});
    expect(queue.approve(entry.id, "alice").applied).toBe(true);
    const count = storage.getDatabase().prepare("SELECT COUNT(*) AS n FROM project_history").get() as { n: number };
    expect(count.n).toBe(0);
    storage.close();
  });
});

// =============================================================================
// THE WIRING
// =============================================================================

describe("bootstrap wires the producers to the daemon's own storage", () => {
  // A recorder nothing injects records nothing, so the wiring IS the feature.
  // Booting the whole system in a unit test is not on; this asserts the boot
  // path the way framework-store-handoff.test.ts does.
  const source = readFileSync("src/core/bootstrap.ts", "utf8");

  it("builds ONE recorder over the shared daemon storage, keyed by the project", () => {
    expect(source).toContain("createProjectHistoryRecorder(sharedDaemonStorage, {");
    expect(source).toMatch(/projectId: config\.unityProjectPath \|\| process\.cwd\(\)/);
  });

  it("hands that recorder to both producers", () => {
    expect(source).toContain("campaignManager?.setProjectHistoryRecorder(projectHistoryRecorder)");
    expect(source).toContain("approvalQueueInstance.setProjectHistoryRecorder(projectHistoryRecorder)");
    // Exactly one recorder, so both producers share one monotonic clock.
    expect(source.match(/createProjectHistoryRecorder\(/g)?.length).toBe(1);
  });
});

// A compile-time reminder that the event shape the producers rely on is the one
// the read surface returns.
const _shape: (e: ProjectHistoryEvent) => string = (e) => e.id;
void _shape;
