import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { DaemonStorage } from "../daemon/daemon-storage.js";
import { OWNER_HEARTBEAT_TTL_MS, UnifiedBudgetManager } from "./unified-budget-manager.js";

vi.mock("../utils/logger.js", () => ({ getLoggerSafe: () => ({ warn: vi.fn() }) }));
let dir: string;
let storage: DaemonStorage;
let manager: UnifiedBudgetManager;
const connections: DaemonStorage[] = [];
function connect() {
  const db = new DaemonStorage(join(dir, "daemon.db"));
  db.initialize();
  db.migrateAgentBudget();
  db.migrateBudgetSource();
  connections.push(db);
  return db;
}
function orphan(source = "agent", sourceId = "alice", estimateUsd = 0.75) {
  storage.upsertBudgetReservation({ id: "orphan", source, sourceId, estimateUsd,
    chargedUsd: 0, ownerPid: 99999999, createdAt: Date.now() });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "budget-r9-"));
  storage = connect();
  manager = new UnifiedBudgetManager(storage, { emit: vi.fn() }, {});
  manager.updateConfig({ dailyLimitUsd: 1, subLimits: { daemonDailyUsd: 0.75, agentDefaultUsd: 0.75, verificationPct: 0.15 } });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const db of connections.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("round 9 bounded budget fixes", () => {
  it("#5 recovered liability consumes the originating agent limit", () => {
    orphan();
    manager.reconcileOrphanedReservations();
    expect(manager.isSourceExceeded("agent", "alice")).toBe(true);
    expect(manager.canSpend(0.3, "chat")).toBe(false);
  });
});

it("#5 recovery does not consume another agent limit", () => {
  orphan();
  manager.reconcileOrphanedReservations();
  expect(manager.isSourceExceeded("agent", "bob")).toBe(false);
  expect(manager.canSpend(0.1, "agent", "bob")).toBe(true);
});

it("#6 admits exact global fits and rejects proposals above source headroom", () => {
  expect(manager.reserveIfAffordable(1, "chat")).toBeTypeOf("string");
  for (const row of storage.listBudgetReservations()) manager.release(row.id);
  expect(manager.reserveIfAffordable(0.76, "agent", "alice")).toBeUndefined();
  expect(manager.reserveIfAffordable(0.76, "daemon")).toBeUndefined();
});

it("#6 guards one cent over, exact source fits, monthly fits and explicit zero freezes", () => {
  expect(manager.reserveIfAffordable(1.01, "chat")).toBeUndefined();
  expect(manager.canSpend(0.75, "agent", "alice")).toBe(true);
  expect(manager.canSpend(0.75, "daemon")).toBe(true);
  manager.updateConfig({ dailyLimitUsd: -1, monthlyLimitUsd: 1 });
  expect(manager.canSpend(1, "chat")).toBe(true);
  expect(manager.canSpend(1.01, "chat")).toBe(false);
  for (const limits of [{ dailyLimitUsd: 0, monthlyLimitUsd: -1 }, { dailyLimitUsd: -1, monthlyLimitUsd: 0 }]) {
    manager.updateConfig(limits);
    expect(manager.reserveIfAffordable(0, "chat")).toBeUndefined();
    expect(manager.reserveIfAffordable(0.01, "daemon")).toBeUndefined();
  }
});

it("#4 failed durable admission returns no authorization and no local reservation", () => {
  vi.spyOn(storage, "upsertBudgetReservation").mockImplementation(() => { throw new Error("disk full"); });
  expect(manager.reserveIfAffordable(0.25, "chat")).toBeUndefined();
  expect(manager.reservationCount()).toBe(0);
  expect(storage.listBudgetReservations()).toEqual([]);
});

it("#4 successful durable admission authorizes exactly the persisted reservation", () => {
  const id = manager.reserveIfAffordable(0.25, "chat");
  expect(id).toBeTypeOf("string");
  expect(storage.listBudgetReservations()).toMatchObject([{ id, estimateUsd: 0.25 }]);
  expect(manager.reservationCount()).toBe(1);
});

it("#2 cost and charged amount roll back together on reservation update failure", () => {
  const id = manager.reserve(0.75, "chat");
  storage.getDatabase().exec("CREATE TRIGGER fail_charge BEFORE UPDATE ON budget_reservations BEGIN SELECT RAISE(ABORT, 'injected charge failure'); END");
  expect(() => manager.recordCost(0.2, "chat", { reservationId: id })).toThrow("injected charge failure");
  expect(storage.sumBudgetSince(0)).toBe(0);
  expect(storage.listBudgetReservations()[0]?.chargedUsd).toBe(0);
  expect(manager.outstandingUsd()).toBe(0.75);
});

it("#2 interrupted reconciliation rolls back and a retry books only once", () => {
  orphan();
  const claim = storage.reconcileBudgetReservation.bind(storage);
  const failure = vi.spyOn(storage, "reconcileBudgetReservation").mockImplementation((id, now) => {
    claim(id, now);
    throw new Error("interrupted claim");
  });
  expect(() => manager.reconcileOrphanedReservations()).toThrow("interrupted claim");
  expect(storage.sumBudgetSince(0)).toBe(0);
  expect(storage.listBudgetReservations()).toMatchObject([{ reconciledAt: null }]);
  failure.mockRestore();
  manager.reconcileOrphanedReservations();
  manager.reconcileOrphanedReservations();
  expect(storage.sumBudgetSince(0)).toBe(0);
  expect(manager.getSnapshot().estimates?.reconciledUsd).toBe(0.75);
});

it("#2 successful charges shrink liability and competing stale reconcilers cannot duplicate recovery", () => {
  const id = manager.reserve(0.75, "chat");
  manager.recordCost(0.2, "chat", { reservationId: id });
  expect(storage.sumBudgetSince(0)).toBe(0.2);
  expect(storage.listBudgetReservations()[0]?.chargedUsd).toBe(0.2);
  manager.release(id);
  orphan();
  const other = new UnifiedBudgetManager(connect(), { emit: vi.fn() }, {});
  const list = storage.listBudgetReservations.bind(storage);
  vi.spyOn(storage, "listBudgetReservations").mockImplementationOnce(() => {
    const stale = list();
    other.reconcileOrphanedReservations();
    return stale;
  });
  expect(manager.reconcileOrphanedReservations().orphans).toBe(0);
  expect(storage.sumBudgetSince(0)).toBe(0.2);
  expect(manager.getSnapshot().estimates?.reconciledUsd).toBe(0.75);
});

it("#2 a released row in a stale recovery list cannot be charged", () => {
  orphan();
  const other = connect();
  const list = storage.listBudgetReservations.bind(storage);
  vi.spyOn(storage, "listBudgetReservations").mockImplementationOnce(() => {
    const stale = list();
    other.deleteBudgetReservation("orphan");
    return stale;
  });
  expect(manager.reconcileOrphanedReservations().orphans).toBe(0);
  expect(storage.sumBudgetSince(0)).toBe(0);
});

it("#3 two managers sharing SQLite cannot reserve more than the wallet", () => {
  const other = new UnifiedBudgetManager(connect(), { emit: vi.fn() }, {});
  expect(manager.reserveIfAffordable(0.75, "chat")).toBeTypeOf("string");
  expect(other.reserveIfAffordable(0.75, "chat")).toBeUndefined();
  expect(other.outstandingUsd()).toBe(0.75);
});

it("#3 a reused pid with a different generation is recovered after boot", () => {
  orphan();
  vi.restoreAllMocks();
  // The previous incarnation held this pid BEFORE we did: its claim is older
  // than our own registration, which is what proves the pid changed hands.
  storage.getDatabase()
    .prepare("UPDATE budget_reservations SET owner_pid = ?, owner_generation = 'previous-incarnation', created_at = ?, claim_seq = 1 WHERE id = 'orphan'")
    .run(process.pid, Date.now() - 60_000);
  // A reused PID does not identify the previous process incarnation.
  expect(manager.reconcileOrphanedReservations().orphans).toBe(1);
});

it("#3 admission reconciles owners that die after boot", () => {
  const owner = { pid: 12345, generation: "first-incarnation" };
  let alive = true;
  const crashed = new UnifiedBudgetManager(connect(), { emit: vi.fn() }, {}, { identity: owner });
  const observer = new UnifiedBudgetManager(storage, { emit: vi.fn() }, {}, { isOwnerAlive: (identity) => alive && identity.generation === owner.generation });
  const id = crashed.reserve(0.75, "chat");
  expect(observer.reconcileOrphanedReservations().orphans).toBe(0);
  alive = false;
  observer.reserveIfAffordable(0.1, "chat");
  expect(storage.listBudgetReservations().find((r) => r.id === id)?.reconciledAt).toBeTypeOf("number");
});

it("#3 live generations keep durable headroom even when wedged and release restores exact fit", () => {
  vi.useFakeTimers();
  const identity = { pid: 12345, generation: "still-live" };
  const owner = new UnifiedBudgetManager(connect(), { emit: vi.fn() }, {}, { identity });
  const observer = new UnifiedBudgetManager(storage, { emit: vi.fn() }, {}, { isOwnerAlive: (o) => o.pid === identity.pid && o.generation === identity.generation });
  const id = owner.reserve(0.75, "chat");
  vi.advanceTimersByTime(40 * 24 * 60 * 60 * 1000);
  expect(observer.reconcileOrphanedReservations().orphans).toBe(0);
  expect(observer.reserveIfAffordable(0.26, "chat")).toBeUndefined();
  const exact = observer.reserveIfAffordable(0.25, "chat");
  expect(exact).toBeTypeOf("string");
  observer.release(exact!);
  owner.release(id);
  expect(observer.reserveIfAffordable(1, "chat")).toBeTypeOf("string");
});

it("#3 admission holds SQLite writer ownership during check and reserve", () => {
  const other = connect();
  other.getDatabase().pragma("busy_timeout = 0");
  const insert = storage.upsertBudgetReservation.bind(storage);
  let contended = false;
  vi.spyOn(storage, "upsertBudgetReservation").mockImplementation((row) => {
    try { other.budgetTransaction(() => undefined); }
    catch { contended = true; }
    insert(row);
  });
  expect(manager.reserveIfAffordable(0.25, "chat")).toBeTypeOf("string");
  expect(contended).toBe(true);
});

it("#1 recovery reports an estimate without inventing a provider charge", () => {
  orphan();
  manager.reconcileOrphanedReservations();
  const snapshot = manager.getSnapshot();
  expect(snapshot.global.daily.usedUsd).toBe(0);
  expect(snapshot.global.monthly.usedUsd).toBe(0);
  expect(storage.getRecentBudgetEntries()).toEqual([]);
  expect(snapshot.estimates).toMatchObject({ kind: "estimate", outstandingUsd: 0.75, reconciledUsd: 0.75, byAgent: { alice: 0.75 } });
  expect(manager.canSpend(0.26, "chat")).toBe(false);
});

it("#1 partial and over-estimate charges stay evidenced while old uncertainty protects the wallet", () => {
  vi.useFakeTimers();
  const id = manager.reserve(0.75, "agent", "alice");
  manager.recordCost(0.2, "agent", { agentId: "alice", reservationId: id });
  // The owner CRASHED: a pid that is not running, naming an incarnation that
  // is gone. Faking it on THIS pid instead would only be a generation mismatch,
  // which since Codex round 12 #1 is no proof of death at all.
  storage.getDatabase().prepare("UPDATE budget_reservations SET owner_generation = 'dead', owner_pid = 99999999 WHERE id = ?").run(id);
  manager.reconcileOrphanedReservations();
  expect(manager.getSnapshot().global.daily.usedUsd).toBe(0.2);
  expect(manager.getSnapshot().estimates?.reconciledUsd).toBeCloseTo(0.55);
  vi.advanceTimersByTime(40 * 24 * 60 * 60 * 1000);
  expect(manager.getSnapshot().global.daily.usedUsd).toBe(0);
  // The estimate REMAINS VISIBLE — nobody ever established what that run
  // spent — but it stops being charged against a window it cannot belong to:
  // holding it against today's rolling 24 hours forever starved the wallet
  // permanently, one crash at a time, with no operator path back.
  expect(manager.getSnapshot().estimates?.reconciledUsd).toBeCloseTo(0.55);
  expect(manager.canSpend(0.46, "chat")).toBe(true);
  manager.recordCost(0.8, "agent", { agentId: "alice", reservationId: id });
  expect(manager.getSnapshot().global.daily.usedUsd).toBe(0.8);
  expect(manager.getSnapshot().estimates?.outstandingUsd).toBe(0);
  expect(storage.sumBudgetSince(0)).toBe(1);
});

it("#1 a live owner's liability never ages out, and reconciled crashes do not accumulate against today", () => {
  vi.useFakeTimers();
  // Three runs die on three different days, each holding $0.30 of the $1 wallet.
  for (let day = 0; day < 3; day++) {
    const id = manager.reserve(0.3, "chat");
    // The owner CRASHED: a pid that is not running, naming an incarnation that
  // is gone. Faking it on THIS pid instead would only be a generation mismatch,
  // which since Codex round 12 #1 is no proof of death at all.
  storage.getDatabase().prepare("UPDATE budget_reservations SET owner_generation = 'dead', owner_pid = 99999999 WHERE id = ?").run(id);
    manager.reconcileOrphanedReservations();
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
  }
  // Their uncertainty is still on the books…
  expect(manager.getSnapshot().estimates?.reconciledUsd).toBeCloseTo(0.9);
  // …but today's wallet is whole: three crashes did not eat it.
  const today = manager.reserveIfAffordable(1, "chat");
  expect(today).toBeTypeOf("string");
  manager.release(today!);

  // A reservation whose owner is ALIVE holds its headroom however long it runs.
  const identity = { pid: 4242, generation: "long-run" };
  const owner = new UnifiedBudgetManager(connect(), { emit: vi.fn() }, {}, { identity });
  const observer = new UnifiedBudgetManager(storage, { emit: vi.fn() }, {}, {
    isOwnerAlive: (o) => o.pid === identity.pid && o.generation === identity.generation,
  });
  owner.reserve(0.8, "chat");
  vi.advanceTimersByTime(40 * 24 * 60 * 60 * 1000);
  expect(observer.reconcileOrphanedReservations().orphans).toBe(0);
  expect(observer.canSpend(0.9, "chat")).toBe(false);
});

it("#4 adapters without durable admission cannot authorize work", () => {
  Object.defineProperty(storage, "upsertBudgetReservation", { value: undefined });
  expect(manager.reserveIfAffordable(0.25, "chat")).toBeUndefined();
  expect(manager.reservationCount()).toBe(0);
});

it("#4 a failed commit returns no authorization or local reservation", () => {
  const transaction = storage.budgetTransaction.bind(storage);
  vi.spyOn(storage, "budgetTransaction").mockImplementation((work) => transaction(() => {
    work();
    throw new Error("commit failed");
  }));
  expect(manager.reserveIfAffordable(0.25, "chat")).toBeUndefined();
  expect(storage.listBudgetReservations()).toEqual([]);
  expect(manager.reservationCount()).toBe(0);
});

it("#4 a zero estimate still requires a durable admission record", () => {
  vi.spyOn(storage, "upsertBudgetReservation").mockImplementation(() => { throw new Error("disk full"); });
  expect(manager.reserveIfAffordable(0, "chat")).toBeUndefined();
  expect(manager.reservationCount()).toBe(0);
});

it("#4 durable zero estimates authorize work without consuming headroom", () => {
  const id = manager.reserveIfAffordable(0, "chat");
  expect(id).toBeTypeOf("string");
  expect(storage.listBudgetReservations()).toMatchObject([{ id, estimateUsd: 0 }]);
  expect(manager.outstandingUsd()).toBe(0);
});

it("#6 fractional exact fits survive ordinary dollar floating point addition", () => {
  manager.updateConfig({ dailyLimitUsd: 0.3, monthlyLimitUsd: 0.3,
    subLimits: { daemonDailyUsd: 0.3, agentDefaultUsd: 0.3, verificationPct: 0.15 } });
  manager.recordCost(0.1, "agent", { agentId: "alice" });
  expect(manager.reserveIfAffordable(0.2, "agent", "alice")).toBeTypeOf("string");
  expect(manager.reserveIfAffordable(0.01, "chat")).toBeUndefined();
});

it("#6 fractional source headroom still rejects one cent over", () => {
  manager.updateConfig({ dailyLimitUsd: -1, monthlyLimitUsd: -1,
    subLimits: { daemonDailyUsd: 0.3, agentDefaultUsd: 0.3, verificationPct: 0.15 } });
  manager.recordCost(0.1, "agent", { agentId: "alice" });
  manager.recordCost(0.1, "daemon", {});
  expect(manager.canSpend(0.2, "agent", "alice")).toBe(true);
  expect(manager.canSpend(0.21, "agent", "alice")).toBe(false);
  expect(manager.canSpend(0.2, "daemon")).toBe(true);
  expect(manager.canSpend(0.21, "daemon")).toBe(false);
});

/**
 * Codex 2026-09-17 round 10 #6 / #7, against the round-9 budget work.
 *
 * #6: admission (canSpend) scoped outstanding liability to the gate's window,
 * but the EXECUTION gates (isGlobalExceeded / isSourceExceeded) asked for
 * outstanding with no window at all, so a reconciled liability from 25 hours
 * ago admitted work and then refused to let it run.
 *
 * #7: the DEFAULT liveness predicate recognised only this process's identity,
 * so a second live process's reservation was "dead", got reconciled, and once
 * its last activity left the window its headroom was handed out twice. No
 * injected callbacks here: production defaults are what must hold.
 */
describe("round 10: window consistency and foreign owner liveness", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const globalOnly = { daemonDailyUsd: 0, agentDefaultUsd: 0, verificationPct: 0.15 };
  /** Every gate's verdict at once, so admission and execution can be compared. */
  const verdicts = (mgr: UnifiedBudgetManager, estimate = 0.25) => ({
    admits: mgr.canSpend(estimate, "agent", "alice"),
    globalOk: !mgr.isGlobalExceeded(),
    sourceOk: !mgr.isSourceExceeded("agent", "alice"),
  });
  /** A reconciled liability of `usd`, owned by a generation that is provably gone. */
  function deadLiability(usd: number, source = "agent", sourceId: string | undefined = "alice") {
    const id = manager.reserve(usd, source as never, sourceId);
    // A PREVIOUS BOOT: the claim predates this incarnation's registration on
    // the pid, which is what makes our own registration proof that the
    // claimant exited (Codex round 12 #1 — a mere generation mismatch is not).
    // Round 13 #1: order, not the clock. A previous boot's claim sits EARLIER
    // in the durable sequence than this incarnation's registration — which is
    // exactly what makes our registration proof that the claimant exited, and
    // what a rolled-back wall clock could no longer show.
    storage.getDatabase()
      .prepare("UPDATE budget_reservations SET owner_generation = 'previous-incarnation', created_at = ?, claim_seq = 1 WHERE id = ?")
      .run(Date.now() - 60_000, id);
    expect(manager.reconcileOrphanedReservations().orphans).toBe(1);
    return id;
  }

  it("#6 admission and the execution gates agree after a daily rollover", () => {
    vi.useFakeTimers();
    manager.updateConfig({ dailyLimitUsd: 1, monthlyLimitUsd: -1, subLimits: { daemonDailyUsd: 1, agentDefaultUsd: 1, verificationPct: 0.15 } });
    deadLiability(1);
    // Same day: the liability is real and every gate refuses.
    expect(verdicts(manager)).toEqual({ admits: false, globalOk: false, sourceOk: false });
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    // After the rollover it belongs to a window that has closed: all three agree.
    expect(verdicts(manager)).toEqual({ admits: true, globalOk: true, sourceOk: true });
  });

  it("#6 the daemon sub-limit gate rolls over exactly when admission does", () => {
    vi.useFakeTimers();
    manager.updateConfig({ dailyLimitUsd: -1, monthlyLimitUsd: -1, subLimits: { daemonDailyUsd: 1, agentDefaultUsd: 0, verificationPct: 0.15 } });
    deadLiability(1, "daemon", undefined);
    expect(manager.canSpend(0.25, "daemon")).toBe(false);
    expect(manager.isSourceExceeded("daemon")).toBe(true);
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    expect(manager.canSpend(0.25, "daemon")).toBe(true);
    expect(manager.isSourceExceeded("daemon")).toBe(false);
  });

  it("#6 admission and the execution gates agree after a monthly rollover", () => {
    vi.useFakeTimers();
    manager.updateConfig({ dailyLimitUsd: 10, monthlyLimitUsd: 1, subLimits: globalOnly });
    deadLiability(1, "chat", undefined);
    // 25 hours on, the daily window has rolled but the MONTHLY window has not:
    // the liability still binds, and both gates must still say so.
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    expect(verdicts(manager)).toEqual({ admits: false, globalOk: false, sourceOk: true });
    // Past 30 days it is out of every window, and the gates agree again.
    vi.advanceTimersByTime(30 * DAY_MS);
    expect(verdicts(manager)).toEqual({ admits: true, globalOk: true, sourceOk: true });
  });

  it("#7 a second live process keeps its headroom under production defaults, aged or not", () => {
    vi.useFakeTimers();
    // A really-running pid this test process did not invent: its parent. The
    // worker's identity is a separate process incarnation over one wallet.
    const worker = new UnifiedBudgetManager(connect(), { emit: vi.fn() }, {}, {
      identity: { pid: process.ppid, generation: "live-worker" },
    });
    // Production defaults on the observer: NO isOwnerAlive callback.
    const observer = new UnifiedBudgetManager(storage, { emit: vi.fn() }, {});
    const held = worker.reserve(0.75, "chat");

    expect(observer.reconcileOrphanedReservations().orphans).toBe(0);
    expect(observer.canSpend(0.5, "chat")).toBe(false);

    // A day later the worker is still running; its reservation has not aged out.
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    expect(observer.reconcileOrphanedReservations().orphans).toBe(0);
    expect(observer.canSpend(0.5, "chat")).toBe(false);
    expect(observer.reserveIfAffordable(0.5, "chat")).toBeUndefined();
    // $0.25 of the wallet is genuinely free, and exactly that much fits.
    expect(observer.isGlobalExceeded()).toBe(false);
    const fits = observer.reserveIfAffordable(0.25, "chat");
    expect(fits).toBeTypeOf("string");
    // Fully committed now — the aged reservation the live worker still holds is
    // counted by the EXECUTION gate too, not just by admission.
    expect(observer.isGlobalExceeded()).toBe(true);
    observer.release(fits!);

    // Only the owner's own release returns the money to the wallet.
    worker.release(held);
    expect(observer.reserveIfAffordable(1, "chat")).toBeTypeOf("string");
  });
});

/**
 * Round 10 #7, the other direction: the registry must not become a blanket
 * amnesty. Proven death still reclaims liability, and only proven death does.
 */
describe("round 10: what the owner registry can and cannot prove", () => {
  const registry = () => storage.listBudgetOwners();
  /** A reservation owned by another incarnation, without touching liveness. */
  function foreign(owner: { pid: number; generation: string }, usd = 0.75) {
    const id = "foreign";
    storage.upsertBudgetReservation({ id, source: "chat", sourceId: null, estimateUsd: usd,
      chargedUsd: 0, ownerPid: owner.pid, ownerGeneration: owner.generation, createdAt: Date.now() });
    return id;
  }

  it("#7 a registered owner that stopped heartbeating and whose PID is gone is reclaimed", () => {
    // Stale registration AND no such process: that is proof, not a guess.
    storage.touchBudgetOwner(99999999, "crashed-worker", Date.now() - 2 * OWNER_HEARTBEAT_TTL_MS);
    foreign({ pid: 99999999, generation: "crashed-worker" });
    expect(manager.reconcileOrphanedReservations().orphans).toBe(1);
  });

  it("#7 a fresh heartbeat outranks a PID probe: a just-registered owner keeps its headroom", () => {
    // Registered one second ago. Even if that PID is already gone, the process
    // was alive a moment ago and its spend may still be arriving.
    storage.touchBudgetOwner(99999999, "just-registered", Date.now() - 1000);
    foreign({ pid: 99999999, generation: "just-registered" });
    expect(manager.reconcileOrphanedReservations().orphans).toBe(0);
    expect(manager.canSpend(0.5, "chat")).toBe(false);
  });

  it("#7 a successor incarnation on the same live PID proves the previous one exited", () => {
    const pid = process.ppid; // really running, so the PID probe proves nothing
    foreign({ pid, generation: "gen-a" });
    storage.touchBudgetOwner(pid, "gen-a", Date.now());
    expect(manager.reconcileOrphanedReservations().orphans).toBe(0);
    // The same PID now hosts a different incarnation, freshly heartbeating.
    storage.touchBudgetOwner(pid, "gen-b", Date.now());
    expect(registry().filter((row) => row.ownerPid === pid)).toMatchObject([{ ownerGeneration: "gen-b" }]);
    expect(manager.reconcileOrphanedReservations().orphans).toBe(1);
  });

  it("#7 an unregistered owner on a running PID is unknown, not dead", () => {
    foreign({ pid: process.ppid, generation: "never-registered" });
    expect(manager.reconcileOrphanedReservations().orphans).toBe(0);
    expect(manager.canSpend(0.5, "chat")).toBe(false);
  });

  it("#7 this process registers itself on every path that commits liability", () => {
    const mine = registry().filter((row) => row.ownerPid === process.pid);
    expect(mine).toHaveLength(1);
    const before = mine[0]!.heartbeatAt;
    vi.useFakeTimers();
    vi.setSystemTime(before + 60_000);
    manager.reserve(0.1, "chat");
    expect(registry().find((row) => row.ownerPid === process.pid)?.heartbeatAt).toBe(before + 60_000);
    vi.setSystemTime(before + 120_000);
    manager.recordCost(0.01, "chat", {});
    expect(registry().find((row) => row.ownerPid === process.pid)?.heartbeatAt).toBe(before + 120_000);
  });

  it("#7 a legacy row with no owner generation is still reclaimable", () => {
    orphan();
    storage.getDatabase().prepare("UPDATE budget_reservations SET owner_pid = ? WHERE id = 'orphan'").run(process.pid);
    expect(manager.reconcileOrphanedReservations().orphans).toBe(1);
  });

  it("#7 owner registrations nobody refreshed for a month are pruned", () => {
    storage.touchBudgetOwner(4242, "ancient", Date.now() - 31 * 24 * 60 * 60 * 1000);
    orphan();
    manager.reconcileOrphanedReservations();
    expect(registry().some((row) => row.ownerPid === 4242)).toBe(false);
    expect(registry().some((row) => row.ownerPid === process.pid)).toBe(true);
  });
});

it("plan 6.1 a recorded cost carries the task and campaign that spent it", () => {
  // Without this the executor named the work and the ledger forgot it: the
  // delivery package could only report a window total nobody can attribute.
  const id = manager.reserve(0.5, "daemon", "task-cost");
  manager.recordCost(0.3, "daemon", { reservationId: id, taskId: "task_9", campaignId: "camp_9" });
  expect(storage.sumBudgetForTask("task_9")).toEqual({ totalUsd: 0.3, entries: 1 });
  expect(storage.sumBudgetForCampaign("camp_9")).toEqual({ totalUsd: 0.3, entries: 1 });
  // Guard: a cost that names no work still records, and belongs to nobody.
  manager.recordCost(0.2, "chat", {});
  expect(storage.sumBudgetForTask("task_9").totalUsd).toBeCloseTo(0.3, 6);
  expect(storage.sumBudgetSince(0)).toBeCloseTo(0.5, 6);
});

/**
 * Round 11 #5. Owner replacement is PERMANENT evidence: a pid hosts one
 * process at a time, so a different incarnation registering on it after a
 * liability was claimed proves the claimant exited — no matter how long the
 * replacement has since been idle. Reading it through the heartbeat TTL made
 * that proof expire, and a dead owner's reservation then held headroom for ever.
 */
describe("round 11 #5: owner-replacement evidence does not expire", () => {
  const pid = process.ppid; // really running, so the PID probe proves nothing
  const FORTY_FIVE_DAYS = 45 * 24 * 60 * 60 * 1000; // past heartbeat TTL and the 30-day retention
  const owners = () => storage.listBudgetOwners();
  function claimed(generation: string, at: number, usd = 0.75) {
    storage.upsertBudgetReservation({ id: "claim", source: "chat", sourceId: null, estimateUsd: usd,
      chargedUsd: 0, ownerPid: pid, ownerGeneration: generation, createdAt: at });
  }

  it("an idle replacement still proves the previous incarnation exited, a month later", () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    claimed("gen-a", t0);
    storage.touchBudgetOwner(pid, "gen-a", t0);
    expect(manager.reconcileOrphanedReservations().orphans).toBe(0);
    // A different incarnation takes the pid a second later, then goes idle.
    storage.touchBudgetOwner(pid, "gen-b", t0 + 1000);
    vi.setSystemTime(t0 + FORTY_FIVE_DAYS);
    expect(manager.reconcileOrphanedReservations().orphans).toBe(1);
    // The evidence survived the retention prune precisely because the claim it
    // answers is still unreconciled at the moment pruning runs.
    expect(owners().filter((row) => row.ownerPid === pid)).toMatchObject([{ ownerGeneration: "gen-b" }]);
  });

  it("a stale MATCHING incarnation is unknown, not dead: its headroom stays", () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    claimed("gen-a", t0);
    storage.touchBudgetOwner(pid, "gen-a", t0);
    vi.setSystemTime(t0 + FORTY_FIVE_DAYS);
    expect(manager.reconcileOrphanedReservations().orphans).toBe(0);
    expect(manager.canSpend(0.5, "chat")).toBe(false);
  });

  it("a registry row from before this column exists migrates, and still keeps its owner's headroom", () => {
    // The live daemon.db has budget_owners without registered_at: every owner
    // statement names that column, so a missing migration would break the
    // wallet outright. A NULL arrival time orders nothing, so the mismatch
    // alone must not condemn an owner whose PID is still running.
    const legacyPath = join(dir, "legacy.db");
    const raw = new Database(legacyPath);
    raw.exec("CREATE TABLE budget_owners (owner_pid INTEGER PRIMARY KEY, owner_generation TEXT NOT NULL, heartbeat_at INTEGER NOT NULL)");
    raw.prepare("INSERT INTO budget_owners VALUES (?, ?, ?)").run(pid, "gen-legacy", Date.now() - 2 * OWNER_HEARTBEAT_TTL_MS);
    raw.close();
    const legacy = new DaemonStorage(legacyPath);
    legacy.initialize();
    legacy.migrateAgentBudget();
    legacy.migrateBudgetSource();
    connections.push(legacy);
    expect(legacy.listBudgetOwners()).toMatchObject([{ ownerPid: pid, ownerGeneration: "gen-legacy" }]);
    expect(legacy.listBudgetOwners()[0]!.registeredAt).toBeUndefined();
    const onLegacy = new UnifiedBudgetManager(legacy, { emit: vi.fn() }, {});
    onLegacy.updateConfig({ dailyLimitUsd: 1 });
    legacy.upsertBudgetReservation({ id: "claim", source: "chat", sourceId: null, estimateUsd: 0.75,
      chargedUsd: 0, ownerPid: pid, ownerGeneration: "gen-a", createdAt: Date.now() });
    expect(onLegacy.reconcileOrphanedReservations().orphans).toBe(0);
    expect(onLegacy.canSpend(0.5, "chat")).toBe(false);
  });

  it("a registration OLDER than the claim names a predecessor, and proves nothing", () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    // The pid's registry row was left by an earlier incarnation and the current
    // owner's own heartbeat (best effort) never landed. Reading the mismatch as
    // death would release a live owner's headroom.
    storage.touchBudgetOwner(pid, "gen-old", t0);
    claimed("gen-a", t0 + 10 * 60 * 1000);
    vi.setSystemTime(t0 + FORTY_FIVE_DAYS);
    expect(manager.reconcileOrphanedReservations().orphans).toBe(0);
    expect(manager.canSpend(0.5, "chat")).toBe(false);
  });
});

/**
 * Codex round 12 #1 and #3. Both are the same error in two places: reading
 * something OTHER than arrival order as proof that a reservation's owner exited.
 */
describe("round 12: only arrival order proves a pid changed hands", () => {
  const pid = process.ppid; // really running, so the PID probe proves nothing

  it("#1 a freshly heartbeating PREDECESSOR does not condemn the live owner", () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    // The predecessor registered and heartbeat a second ago — inside the TTL.
    storage.touchBudgetOwner(pid, "gen-old", t0 - 1000);
    // The live owner claimed AFTER it; its own registration never landed
    // (heartbeats are best effort, and the write can simply fail).
    storage.upsertBudgetReservation({ id: "live", source: "chat", sourceId: null, estimateUsd: 0.75,
      chargedUsd: 0, ownerPid: pid, ownerGeneration: "gen-live", createdAt: t0 });
    expect(manager.reconcileOrphanedReservations().orphans).toBe(0);
    expect(manager.canSpend(0.5, "chat")).toBe(false);
  });

  it("#3 late accounting against a dead owner's reservation does not erase the replacement's proof", () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    storage.upsertBudgetReservation({ id: "dead", source: "chat", sourceId: null, estimateUsd: 0.75,
      chargedUsd: 0, ownerPid: pid, ownerGeneration: "gen-dead", createdAt: t0 });
    // The replacement takes the pid a second later: the claimant is gone.
    storage.touchBudgetOwner(pid, "gen-new", t0 + 1000);
    // Whoever is doing the accounting records a late cost against that
    // reservation, moving its activity past the replacement's registration.
    storage.chargeBudgetReservation("dead", 0.1, t0 + 60_000);
    vi.setSystemTime(t0 + 45 * 24 * 60 * 60 * 1000);
    // Activity is not the owner's heartbeat, so it cannot outrank the proof.
    expect(manager.reconcileOrphanedReservations().orphans).toBe(1);
  });
});

/**
 * Codex round 12 #2. Two machines can share one wallet. A pid is only
 * meaningful together with the host it belongs to: our own pid table cannot be
 * asked about a foreign pid, and a foreign machine's registration says nothing
 * about ours.
 */
describe("round 12 #2: a pid means nothing without its host", () => {
  it("a reservation from ANOTHER host is never reclaimed from a local PID probe", () => {
    // pid 99999999 does not exist HERE, which used to read as proof of death.
    storage.upsertBudgetReservation({ id: "remote", source: "chat", sourceId: null, estimateUsd: 0.75,
      chargedUsd: 0, ownerPid: 99999999, ownerGeneration: "remote-gen", ownerHost: "build-box-2", createdAt: Date.now() });
    expect(manager.reconcileOrphanedReservations().orphans).toBe(0);
    expect(manager.canSpend(0.5, "chat")).toBe(false);
  });

  it("another host's registration on the same pid number proves nothing about ours", () => {
    const t0 = Date.now();
    storage.upsertBudgetReservation({ id: "local", source: "chat", sourceId: null, estimateUsd: 0.75,
      chargedUsd: 0, ownerPid: process.ppid, ownerGeneration: "our-gen", ownerHost: os.hostname(), createdAt: t0 });
    // The other machine happens to run its daemon on the same pid NUMBER.
    storage.touchBudgetOwner(process.ppid, "their-gen", t0 + 1000, "build-box-2");
    expect(manager.reconcileOrphanedReservations().orphans).toBe(0);
    expect(manager.canSpend(0.5, "chat")).toBe(false);
    // Our OWN host taking that pid is still proof, so nothing is lost.
    storage.touchBudgetOwner(process.ppid, "successor-gen", t0 + 2000, os.hostname());
    expect(manager.reconcileOrphanedReservations().orphans).toBe(1);
  });

  it("a row with no host recorded still behaves exactly as it did before the column", () => {
    const t0 = Date.now();
    storage.upsertBudgetReservation({ id: "legacy", source: "chat", sourceId: null, estimateUsd: 0.75,
      chargedUsd: 0, ownerPid: 99999999, ownerGeneration: "legacy-gen", createdAt: t0 });
    // No host on either side: this host, and the pid is gone.
    expect(manager.reconcileOrphanedReservations().orphans).toBe(1);
  });
});

it("round 12 #2 a reservation records the host that made it, so another machine reads it as foreign", () => {
  const id = manager.reserve(0.75, "chat");
  const row = storage.listBudgetReservations().find((r) => r.id === id)!;
  expect(row.ownerHost).toBe(os.hostname());
  // A manager on a DIFFERENT machine sharing this wallet can neither probe that
  // pid nor prove anything about it: the liability stands.
  const elsewhere = new UnifiedBudgetManager(connect(), { emit: vi.fn() }, {}, {
    identity: { pid: process.pid, generation: "their-gen", host: "build-box-2" },
  });
  elsewhere.updateConfig({ dailyLimitUsd: 1 });
  expect(elsewhere.reconcileOrphanedReservations().orphans).toBe(0);
  expect(elsewhere.canSpend(0.5, "chat")).toBe(false);
});

/**
 * Codex round 13 #1 and #2. Wall-clock ordering and a pid-keyed registry were
 * both wrong for the same reason: they answered a question about ORDER and
 * IDENTITY with something that is neither.
 */
describe("round 13: order is durable, identity is (host, pid)", () => {
  const pid = process.ppid; // really running, so the PID probe proves nothing

  it("#1 a clock that moved backwards cannot make a predecessor prove death", () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    // Before the reboot: a predecessor registered, with a LATER wall clock.
    storage.touchBudgetOwner(pid, "gen-old", t0 + 5_000, os.hostname());
    const older = storage.listBudgetOwners().find((row) => row.ownerPid === pid)!;
    expect(older.registeredSeq).toBeTypeOf("number");
    // After the reboot the clock reads earlier, and the live owner claims now.
    // Its own registration never lands (heartbeats are best effort).
    storage.upsertBudgetReservation({ id: "live", source: "chat", sourceId: null, estimateUsd: 0.75,
      chargedUsd: 0, ownerPid: pid, ownerGeneration: "gen-live", ownerHost: os.hostname(), createdAt: t0 });
    const claim = storage.listBudgetReservations().find((row) => row.id === "live")!;
    // The claim is LATER in the durable order even though its clock reads earlier.
    expect(claim.claimSeq!).toBeGreaterThan(older.registeredSeq!);
    expect(claim.createdAt).toBeLessThan(older.heartbeatAt);
    expect(manager.reconcileOrphanedReservations().orphans).toBe(0);
    expect(manager.canSpend(0.5, "chat")).toBe(false);
  });

  it("#1 a registration that really is later still proves the claimant exited (guard)", () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    storage.upsertBudgetReservation({ id: "dead", source: "chat", sourceId: null, estimateUsd: 0.75,
      chargedUsd: 0, ownerPid: pid, ownerGeneration: "gen-dead", ownerHost: os.hostname(), createdAt: t0 });
    // The successor registers AFTER that claim, in the durable order.
    storage.touchBudgetOwner(pid, "gen-new", t0 + 1_000, os.hostname());
    expect(manager.reconcileOrphanedReservations().orphans).toBe(1);
  });

  it("#2 two machines on one wallet keep their own liveness evidence", () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    // Host A's claim, and host A's own successor registration: proof of death.
    storage.upsertBudgetReservation({ id: "a-dead", source: "chat", sourceId: null, estimateUsd: 0.5,
      chargedUsd: 0, ownerPid: 4242, ownerGeneration: "a-gen", ownerHost: os.hostname(), createdAt: t0 });
    storage.touchBudgetOwner(4242, "a-successor", t0 + 1_000, os.hostname());
    // Host B runs its daemon on the same pid NUMBER and heartbeats.
    storage.touchBudgetOwner(4242, "b-gen", t0 + 2_000, "build-box-2");
    // Both rows survive: the registry is keyed by (host, pid), not by pid.
    expect(storage.listBudgetOwners().filter((row) => row.ownerPid === 4242)).toHaveLength(2);
    // And host A's proof still stands.
    expect(manager.reconcileOrphanedReservations().orphans).toBe(1);
  });

  it("#2 another machine's registration is not evidence about our pid", () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    // OUR claim on a pid that IS running here — so the PID probe answers
    // "unknown" and only the registry could produce a verdict — and no
    // successor of ours: nothing here proves our owner exited.
    storage.upsertBudgetReservation({ id: "ours", source: "chat", sourceId: null, estimateUsd: 0.75,
      chargedUsd: 0, ownerPid: pid, ownerGeneration: "our-gen", ownerHost: os.hostname(), createdAt: t0 });
    // The other machine runs its daemon on the same pid NUMBER, later in the
    // durable order. Keyed by pid alone this row displaced ours and "proved"
    // our live owner dead.
    storage.touchBudgetOwner(pid, "their-gen", t0 + 5_000, "build-box-2");
    expect(manager.reconcileOrphanedReservations().orphans).toBe(0);
    expect(manager.canSpend(0.5, "chat")).toBe(false);
  });

  it("#2 a legacy row with no host recorded still answers for this host", () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    storage.getDatabase()
      .prepare("INSERT INTO budget_owners (owner_host, owner_pid, owner_generation, heartbeat_at, registered_seq, registered_at) VALUES ('', ?, 'successor', ?, 99999, ?)")
      .run(pid, t0 + 1_000, t0 + 1_000);
    storage.upsertBudgetReservation({ id: "legacy", source: "chat", sourceId: null, estimateUsd: 0.75,
      chargedUsd: 0, ownerPid: pid, ownerGeneration: "gen-dead", createdAt: t0 });
    // The hostless row is read as this host's, exactly as it was before hosts
    // were recorded — so an upgrade changes nobody's reading.
    expect(manager.reconcileOrphanedReservations().orphans).toBe(1);
  });
});
