import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonStorage } from "../daemon/daemon-storage.js";
import { UnifiedBudgetManager } from "./unified-budget-manager.js";

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
  storage.getDatabase().prepare("UPDATE budget_reservations SET owner_pid = ?, owner_generation = 'previous-incarnation' WHERE id = 'orphan'").run(process.pid);
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
  storage.getDatabase().prepare("UPDATE budget_reservations SET owner_generation = 'dead' WHERE id = ?").run(id);
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
    storage.getDatabase().prepare("UPDATE budget_reservations SET owner_generation = 'dead' WHERE id = ?").run(id);
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
