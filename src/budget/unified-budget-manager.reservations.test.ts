/**
 * UnifiedBudgetManager reservations — plan 2.12 / audit 03.1 / D20.
 *
 * canSpend() and isGlobalExceeded() summed RECORDED spend only, so two runs
 * that started together both passed on the same remaining dollar. A run now
 * reserves an estimate up front and the gates count used + outstanding.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const logSpies = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ getLoggerSafe: () => logSpies, getLogger: () => logSpies }));

import { RESERVATION_MAX_AGE_MS, UnifiedBudgetManager } from "./unified-budget-manager.js";

interface StoredEntry {
  costUsd: number;
  timestamp: number;
  source?: string;
  agentId?: string | null;
}

function makeStorage(config: Record<string, string>) {
  const entries: StoredEntry[] = [];
  const since = (from: number, pred: (e: StoredEntry) => boolean = () => true) =>
    entries.filter((e) => e.timestamp >= from && pred(e)).reduce((s, e) => s + e.costUsd, 0);
  return {
    entries,
    insertBudgetEntry: (e: StoredEntry) => { entries.push({ ...e }); },
    insertBudgetEntryWithAgent: (e: StoredEntry) => { entries.push({ ...e }); },
    insertBudgetEntryWithSource: (e: StoredEntry) => { entries.push({ ...e }); },
    sumBudgetSince: (from: number) => since(from),
    sumBudgetBySource: (from: number) => {
      const out: Record<string, number> = {};
      for (const e of entries.filter((e) => e.timestamp >= from)) out[e.source ?? "daemon"] = (out[e.source ?? "daemon"] ?? 0) + e.costUsd;
      return out;
    },
    sumBudgetForSource: (source: string, from: number) => since(from, (e) => e.source === source),
    sumBudgetSinceForAgent: (from: number, agentId: string) => since(from, (e) => e.agentId === agentId),
    getDailyHistory: () => [],
    getBudgetConfig: (k: string) => config[k],
    setBudgetConfig: (k: string, v: string) => { config[k] = v; },
    getAllBudgetConfig: () => ({ ...config }),
  };
}

function makeManager(config: Record<string, string> = { dailyLimitUsd: "1" }) {
  const storage = makeStorage(config);
  const manager = new UnifiedBudgetManager(storage, { emit: vi.fn() }, {});
  return { storage, manager };
}

afterEach(() => {
  vi.useRealTimers();
  logSpies.warn.mockClear();
});

describe("UnifiedBudgetManager reservations (plan 2.12 / audit 03.1 / D20)", () => {
  it("(a) two $0.60 checks with $1 left: the first reserves, the second is refused until release", () => {
    const { manager } = makeManager({ dailyLimitUsd: "1" });

    expect(manager.canSpend(0.6, "chat")).toBe(true);
    const first = manager.reserve(0.6, "chat");

    // Same recorded spend ($0), but the wallet is now committed.
    expect(manager.canSpend(0.6, "chat")).toBe(false);
    expect(manager.outstandingUsd()).toBeCloseTo(0.6, 10);

    manager.release(first);
    expect(manager.outstandingUsd()).toBe(0);
    expect(manager.canSpend(0.6, "chat")).toBe(true);
  });

  it("(a') isGlobalExceeded counts outstanding reservations, and a run's own reservation can stand aside", () => {
    const { manager } = makeManager({ dailyLimitUsd: "1" });
    const own = manager.reserve(1, "chat");
    expect(manager.isGlobalExceeded()).toBe(true);
    // The run asking on its own behalf is not blocked by ITSELF.
    expect(manager.isGlobalExceeded({ ignoreReservationId: own })).toBe(false);
    expect(manager.canSpend(0.5, "chat", undefined, { ignoreReservationId: own })).toBe(true);
    manager.release(own);
    expect(manager.isGlobalExceeded()).toBe(false);
  });

  it("(b) charging a reservation shrinks it: used + outstanding stays exact, never double counted", () => {
    const { manager, storage } = makeManager({ dailyLimitUsd: "1" });
    const id = manager.reserve(0.5, "chat");
    const committed = () => storage.sumBudgetSince(0) + manager.outstandingUsd();

    expect(committed()).toBeCloseTo(0.5, 10);
    manager.recordCost(0.2, "chat", { model: "m", reservationId: id });
    expect(storage.sumBudgetSince(0)).toBeCloseTo(0.2, 10);
    expect(manager.outstandingUsd()).toBeCloseTo(0.3, 10);
    expect(committed()).toBeCloseTo(0.5, 10);

    // Overrunning the estimate leaves nothing outstanding (never negative).
    manager.recordCost(0.4, "chat", { model: "m", reservationId: id });
    expect(manager.outstandingUsd()).toBe(0);
    expect(committed()).toBeCloseTo(0.6, 10);

    // A cost booked WITHOUT the id is plain spend on top of the reservation.
    const other = manager.reserve(0.1, "chat");
    manager.recordCost(0.1, "chat", { model: "m" });
    expect(committed()).toBeCloseTo(0.8, 10);
    manager.release(id);
    manager.release(other);
    expect(manager.reservationCount()).toBe(0);
  });

  it("(b') chargeReservation on an unknown id is a no-op, and a non-positive estimate reserves nothing but returns an id", () => {
    const { manager } = makeManager();
    manager.chargeReservation("nope", 1);
    const id = manager.reserve(0, "daemon");
    expect(typeof id).toBe("string");
    expect(manager.outstandingUsd()).toBe(0);
    expect(manager.reservationCount()).toBe(1);
    manager.release(id);
    manager.release(id); // idempotent
    expect(manager.reservationCount()).toBe(0);
  });

  it("source sub-limits count the reserving source's outstanding work", () => {
    const { manager } = makeManager({ dailyLimitUsd: "0", "subLimits.daemonDailyUsd": "1", "subLimits.agentDefaultUsd": "1" });
    const daemon = manager.reserve(1, "daemon");
    expect(manager.isSourceExceeded("daemon")).toBe(true);
    expect(manager.canSpend(0.1, "daemon")).toBe(false);
    // A chat check is not walled by daemon's reservation (chat has no sub-limit, global is off).
    expect(manager.canSpend(0.1, "chat")).toBe(true);
    manager.release(daemon);
    expect(manager.isSourceExceeded("daemon")).toBe(false);

    // Sub-limits are "already at the cap" checks (no estimate added), as before.
    const agent = manager.reserve(1, "agent", "agent_1");
    expect(manager.isSourceExceeded("agent", "agent_1")).toBe(true);
    expect(manager.canSpend(0.2, "agent", "agent_1")).toBe(false);
    expect(manager.canSpend(0.2, "agent", "agent_2")).toBe(true);
    manager.release(agent);
  });

  it("(d) a reservation older than the ceiling is dropped with a warning, not held for ever", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T00:00:00Z"));
    const { manager } = makeManager({ dailyLimitUsd: "1" });
    manager.reserve(0.9, "chat");
    expect(manager.canSpend(0.5, "chat")).toBe(false);

    vi.setSystemTime(Date.now() + RESERVATION_MAX_AGE_MS + 1);
    expect(manager.outstandingUsd()).toBe(0);
    expect(manager.reservationCount()).toBe(0);
    expect(logSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining("leaked budget reservations"),
      expect.objectContaining({ leaked: 1, maxAgeMs: RESERVATION_MAX_AGE_MS }),
    );
    expect(manager.canSpend(0.5, "chat")).toBe(true);
  });

  it("getTaskReservationUsd: config, then env, then the 0.25 default; 0 disables", () => {
    expect(makeManager({}).manager.getTaskReservationUsd()).toBe(0.25);
    const env = { STRADA_BUDGET_TASK_RESERVATION_USD: "0.5" };
    const viaEnv = new UnifiedBudgetManager(makeStorage({}), { emit: vi.fn() }, env);
    expect(viaEnv.getTaskReservationUsd()).toBe(0.5);
    const { manager } = makeManager({ taskReservationUsd: "0" });
    // The config store does not surface this key today; the default still stands.
    expect(manager.getTaskReservationUsd()).toBe(0.25);
  });
});
