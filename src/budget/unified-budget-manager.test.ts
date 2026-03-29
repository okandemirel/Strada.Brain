import { describe, it, expect, beforeEach } from "vitest";
import { UnifiedBudgetManager } from "./unified-budget-manager.js";

// ---------------------------------------------------------------------------
// Mock storage
// ---------------------------------------------------------------------------

interface StoredEntry {
  costUsd: number;
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  triggerName?: string | null;
  timestamp: number;
  source?: string;
  agentId?: string | null;
}

function makeMockStorage(configOverrides: Record<string, string> = {}) {
  const entries: StoredEntry[] = [];
  const config: Record<string, string> = { ...configOverrides };

  return {
    entries,
    insertBudgetEntry(entry: StoredEntry) {
      entries.push({ ...entry });
    },
    insertBudgetEntryWithAgent(entry: StoredEntry & { agentId: string }) {
      entries.push({ ...entry });
    },
    insertBudgetEntryWithSource(entry: StoredEntry & { source: string }) {
      entries.push({ ...entry });
    },
    sumBudgetSince(windowStart: number): number {
      return entries
        .filter((e) => e.timestamp >= windowStart)
        .reduce((sum, e) => sum + e.costUsd, 0);
    },
    sumBudgetBySource(windowStart: number): Record<string, number> {
      const result: Record<string, number> = {};
      for (const e of entries.filter((e) => e.timestamp >= windowStart)) {
        const src = e.source ?? "daemon";
        result[src] = (result[src] ?? 0) + e.costUsd;
      }
      return result;
    },
    sumBudgetForSource(source: string, windowStart: number): number {
      return entries
        .filter((e) => e.timestamp >= windowStart && e.source === source)
        .reduce((sum, e) => sum + e.costUsd, 0);
    },
    sumBudgetSinceForAgent(windowStart: number, agentId: string): number {
      return entries
        .filter((e) => e.timestamp >= windowStart && e.agentId === agentId)
        .reduce((sum, e) => sum + e.costUsd, 0);
    },
    getDailyHistory(windowStart: number): Array<{ day: string; source: string; total: number }> {
      const grouped = new Map<string, number>();
      for (const e of entries.filter((e) => e.timestamp >= windowStart)) {
        const day = new Date(e.timestamp).toISOString().slice(0, 10);
        const src = e.source ?? "daemon";
        const key = `${day}|${src}`;
        grouped.set(key, (grouped.get(key) ?? 0) + e.costUsd);
      }
      return [...grouped.entries()].map(([key, total]) => {
        const [day, source] = key.split("|");
        return { day, source, total };
      });
    },
    getBudgetConfig(key: string): string | undefined {
      return config[key];
    },
    setBudgetConfig(key: string, value: string): void {
      config[key] = value;
    },
    getAllBudgetConfig(): Record<string, string> {
      return { ...config };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock event bus
// ---------------------------------------------------------------------------

function makeMockEventBus() {
  const events: Array<{ event: string; payload: unknown }> = [];
  return {
    events,
    emit(event: string, payload: unknown) {
      events.push({ event, payload });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UnifiedBudgetManager", () => {
  let storage: ReturnType<typeof makeMockStorage>;
  let bus: ReturnType<typeof makeMockEventBus>;
  let mgr: UnifiedBudgetManager;

  beforeEach(() => {
    storage = makeMockStorage();
    bus = makeMockEventBus();
    mgr = new UnifiedBudgetManager(storage, bus);
  });

  // -------------------------------------------------------------------------
  // recordCost
  // -------------------------------------------------------------------------

  describe("recordCost", () => {
    it("calls insertBudgetEntryWithSource for daemon source", () => {
      mgr.recordCost(0.5, "daemon", { model: "gpt-4o" });
      expect(storage.entries).toHaveLength(1);
      expect(storage.entries[0]).toMatchObject({ costUsd: 0.5, source: "daemon", model: "gpt-4o" });
    });

    it("calls insertBudgetEntryWithSource with agentId for agent source", () => {
      mgr.recordCost(1.0, "agent", { agentId: "agent-123", model: "claude-3" });
      expect(storage.entries).toHaveLength(1);
      expect(storage.entries[0]).toMatchObject({ costUsd: 1.0, source: "agent", agentId: "agent-123" });
    });

    it("calls insertBudgetEntryWithSource for agent source without agentId", () => {
      mgr.recordCost(0.3, "agent", { model: "claude-3" });
      expect(storage.entries).toHaveLength(1);
      expect(storage.entries[0]).toMatchObject({ costUsd: 0.3, source: "agent" });
      expect(storage.entries[0].agentId).toBeUndefined();
    });

    it("calls insertBudgetEntryWithSource for chat source", () => {
      mgr.recordCost(0.1, "chat", {});
      expect(storage.entries).toHaveLength(1);
      expect(storage.entries[0]).toMatchObject({ costUsd: 0.1, source: "chat" });
    });

    it("skips zero amount", () => {
      mgr.recordCost(0, "daemon", {});
      expect(storage.entries).toHaveLength(0);
    });

    it("skips negative amount", () => {
      mgr.recordCost(-1, "daemon", {});
      expect(storage.entries).toHaveLength(0);
    });

    it("falls back to insertBudgetEntry when insertBudgetEntryWithSource is absent", () => {
      const legacyStorage = {
        ...storage,
        insertBudgetEntryWithSource: undefined as unknown as undefined,
      };
      const legacyMgr = new UnifiedBudgetManager(legacyStorage as never, bus);
      legacyMgr.recordCost(0.2, "daemon", {});
      expect(storage.entries).toHaveLength(1);
      expect(storage.entries[0]).toMatchObject({ costUsd: 0.2 });
    });
  });

  // -------------------------------------------------------------------------
  // isGlobalExceeded
  // -------------------------------------------------------------------------

  describe("isGlobalExceeded", () => {
    it("returns false when no daily or monthly limit is set (0)", () => {
      mgr.recordCost(100, "daemon", {});
      expect(mgr.isGlobalExceeded()).toBe(false);
    });

    it("returns true when daily limit is exceeded", () => {
      mgr.updateConfig({ dailyLimitUsd: 1.0 });
      mgr.recordCost(1.5, "daemon", {});
      expect(mgr.isGlobalExceeded()).toBe(true);
    });

    it("returns true exactly at daily limit boundary", () => {
      mgr.updateConfig({ dailyLimitUsd: 1.0 });
      mgr.recordCost(1.0, "daemon", {});
      expect(mgr.isGlobalExceeded()).toBe(true);
    });

    it("returns false when under daily limit", () => {
      mgr.updateConfig({ dailyLimitUsd: 10.0 });
      mgr.recordCost(5.0, "daemon", {});
      expect(mgr.isGlobalExceeded()).toBe(false);
    });

    it("returns true when monthly limit is exceeded", () => {
      mgr.updateConfig({ monthlyLimitUsd: 2.0 });
      mgr.recordCost(3.0, "daemon", {});
      expect(mgr.isGlobalExceeded()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getSnapshot
  // -------------------------------------------------------------------------

  describe("getSnapshot", () => {
    it("returns complete snapshot with correct breakdown", () => {
      mgr.updateConfig({ dailyLimitUsd: 10.0, monthlyLimitUsd: 100.0 });
      mgr.recordCost(1.0, "daemon", {});
      mgr.recordCost(2.0, "agent", { agentId: "a1" });
      mgr.recordCost(0.5, "chat", {});
      mgr.recordCost(0.25, "verification", {});

      const snap = mgr.getSnapshot();

      expect(snap.global.daily.usedUsd).toBeCloseTo(3.75);
      expect(snap.global.daily.limitUsd).toBe(10.0);
      expect(snap.global.monthly.limitUsd).toBe(100.0);
      expect(snap.breakdown.daemon).toBeCloseTo(1.0);
      expect(snap.breakdown.agents).toBeCloseTo(2.0);
      expect(snap.breakdown.chat).toBeCloseTo(0.5);
      expect(snap.breakdown.verification).toBeCloseTo(0.25);
    });

    it("returns zero breakdown for empty storage", () => {
      const snap = mgr.getSnapshot();
      expect(snap.breakdown.daemon).toBe(0);
      expect(snap.breakdown.agents).toBe(0);
      expect(snap.breakdown.chat).toBe(0);
      expect(snap.breakdown.verification).toBe(0);
    });

    it("reports daemonExceeded when daemon sub-limit is set and hit", () => {
      mgr.updateConfig({ subLimits: { daemonDailyUsd: 1.0, agentDefaultUsd: 5.0, verificationPct: 15 } });
      mgr.recordCost(1.5, "daemon", {});
      const snap = mgr.getSnapshot();
      expect(snap.subLimitStatus.daemonExceeded).toBe(true);
    });

    it("does not report daemonExceeded when daemon sub-limit is 0", () => {
      mgr.recordCost(100.0, "daemon", {});
      const snap = mgr.getSnapshot();
      expect(snap.subLimitStatus.daemonExceeded).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // checkAndEmitEvents
  // -------------------------------------------------------------------------

  describe("checkAndEmitEvents", () => {
    it("emits budget:warning when warnPct crossed", () => {
      mgr.updateConfig({ dailyLimitUsd: 10.0, warnPct: 0.8 });
      mgr.recordCost(8.5, "daemon", {});
      mgr.checkAndEmitEvents();

      const warnings = bus.events.filter((e) => e.event === "budget:warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].payload).toMatchObject({ source: "global" });
    });

    it("emits budget:exceeded when daily limit hit", () => {
      mgr.updateConfig({ dailyLimitUsd: 10.0 });
      mgr.recordCost(12.0, "daemon", {});
      mgr.checkAndEmitEvents();

      const exceeded = bus.events.filter((e) => e.event === "budget:exceeded");
      expect(exceeded).toHaveLength(1);
      expect(exceeded[0].payload).toMatchObject({ source: "global", isGlobal: true });
    });

    it("does not re-emit budget:exceeded on subsequent calls (dedup)", () => {
      mgr.updateConfig({ dailyLimitUsd: 5.0 });
      mgr.recordCost(6.0, "daemon", {});
      mgr.checkAndEmitEvents();
      mgr.checkAndEmitEvents();

      const exceeded = bus.events.filter((e) => e.event === "budget:exceeded");
      expect(exceeded).toHaveLength(1);
    });

    it("does not re-emit budget:warning on subsequent calls (dedup)", () => {
      mgr.updateConfig({ dailyLimitUsd: 10.0, warnPct: 0.5 });
      mgr.recordCost(6.0, "daemon", {});
      mgr.checkAndEmitEvents();
      mgr.checkAndEmitEvents();

      const warnings = bus.events.filter((e) => e.event === "budget:warning");
      expect(warnings).toHaveLength(1);
    });

    it("does nothing when dailyLimitUsd is 0", () => {
      mgr.recordCost(100.0, "daemon", {});
      mgr.checkAndEmitEvents();
      expect(bus.events).toHaveLength(0);
    });

    it("resets exceeded/warning flags when budget recovers (sum drops below limit)", () => {
      // Set a limit, exceed it, check events, then clear entries to simulate recovery
      mgr.updateConfig({ dailyLimitUsd: 10.0, warnPct: 0.8 });
      mgr.recordCost(12.0, "daemon", {});
      mgr.checkAndEmitEvents();
      expect(bus.events.some((e) => e.event === "budget:exceeded")).toBe(true);

      // Clear stored entries to simulate dropping below limit
      storage.entries.length = 0;
      mgr.checkAndEmitEvents(); // pct < 1 — should reset internal flags

      // Now add warning-level spend and confirm warning fires again
      mgr.recordCost(8.5, "daemon", {});
      mgr.checkAndEmitEvents();

      const warnings = bus.events.filter((e) => e.event === "budget:warning");
      expect(warnings.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // isSourceExceeded
  // -------------------------------------------------------------------------

  describe("isSourceExceeded", () => {
    it("returns false for daemon when daemonDailyUsd is 0", () => {
      mgr.recordCost(50.0, "daemon", {});
      expect(mgr.isSourceExceeded("daemon")).toBe(false);
    });

    it("returns true for daemon when sub-limit hit", () => {
      mgr.updateConfig({ subLimits: { daemonDailyUsd: 2.0, agentDefaultUsd: 5.0, verificationPct: 15 } });
      mgr.recordCost(2.5, "daemon", {});
      expect(mgr.isSourceExceeded("daemon")).toBe(true);
    });

    it("returns false for daemon when under sub-limit", () => {
      mgr.updateConfig({ subLimits: { daemonDailyUsd: 10.0, agentDefaultUsd: 5.0, verificationPct: 15 } });
      mgr.recordCost(3.0, "daemon", {});
      expect(mgr.isSourceExceeded("daemon")).toBe(false);
    });

    it("returns true for agent when per-agent sub-limit hit", () => {
      mgr.updateConfig({ subLimits: { daemonDailyUsd: 0, agentDefaultUsd: 5.0, verificationPct: 15 } });
      mgr.recordCost(6.0, "agent", { agentId: "bot-1" });
      expect(mgr.isSourceExceeded("agent", "bot-1")).toBe(true);
    });

    it("returns false for agent when under per-agent sub-limit", () => {
      mgr.updateConfig({ subLimits: { daemonDailyUsd: 0, agentDefaultUsd: 5.0, verificationPct: 15 } });
      mgr.recordCost(2.0, "agent", { agentId: "bot-1" });
      expect(mgr.isSourceExceeded("agent", "bot-1")).toBe(false);
    });

    it("returns false for agent when agentDefaultUsd is 0", () => {
      mgr.updateConfig({ subLimits: { daemonDailyUsd: 0, agentDefaultUsd: 0, verificationPct: 15 } });
      mgr.recordCost(50.0, "agent", { agentId: "bot-2" });
      expect(mgr.isSourceExceeded("agent", "bot-2")).toBe(false);
    });

    it("always returns false for chat source", () => {
      mgr.recordCost(100.0, "chat", {});
      expect(mgr.isSourceExceeded("chat")).toBe(false);
    });

    it("always returns false for verification source", () => {
      mgr.recordCost(100.0, "verification", {});
      expect(mgr.isSourceExceeded("verification")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // canSpend
  // -------------------------------------------------------------------------

  describe("canSpend", () => {
    it("returns true when no limits are set", () => {
      expect(mgr.canSpend(1.0, "daemon")).toBe(true);
    });

    it("returns false when global daily limit exceeded", () => {
      mgr.updateConfig({ dailyLimitUsd: 1.0 });
      mgr.recordCost(2.0, "daemon", {});
      expect(mgr.canSpend(0.01, "daemon")).toBe(false);
    });

    it("returns false when source sub-limit exceeded", () => {
      mgr.updateConfig({ subLimits: { daemonDailyUsd: 1.0, agentDefaultUsd: 5.0, verificationPct: 15 } });
      mgr.recordCost(1.5, "daemon", {});
      expect(mgr.canSpend(0.01, "daemon")).toBe(false);
    });

    it("returns false when both global and source limits exceeded", () => {
      mgr.updateConfig({ dailyLimitUsd: 1.0, subLimits: { daemonDailyUsd: 0.5, agentDefaultUsd: 5.0, verificationPct: 15 } });
      mgr.recordCost(2.0, "daemon", {});
      expect(mgr.canSpend(0.01, "daemon")).toBe(false);
    });

    it("returns true for chat even with heavy spend (no sub-limit)", () => {
      mgr.recordCost(10.0, "chat", {});
      expect(mgr.canSpend(1.0, "chat")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getDailyHistory
  // -------------------------------------------------------------------------

  describe("getDailyHistory", () => {
    it("aggregates raw history into DailyHistoryEntry format", () => {
      const today = new Date().toISOString().slice(0, 10);
      mgr.recordCost(1.0, "daemon", {});
      mgr.recordCost(2.0, "agent", { agentId: "a1" });
      mgr.recordCost(0.5, "chat", {});

      const history = mgr.getDailyHistory(7);
      expect(history).toHaveLength(1);
      expect(history[0].date).toBe(today);
      expect(history[0].daemon).toBeCloseTo(1.0);
      expect(history[0].agents).toBeCloseTo(2.0);
      expect(history[0].chat).toBeCloseTo(0.5);
      expect(history[0].verification).toBeCloseTo(0);
      expect(history[0].total).toBeCloseTo(3.5);
    });

    it("returns empty array when no entries exist", () => {
      const history = mgr.getDailyHistory(7);
      expect(history).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // updateConfig
  // -------------------------------------------------------------------------

  describe("updateConfig", () => {
    it("delegates to config store and reflects new values", () => {
      mgr.updateConfig({ dailyLimitUsd: 20.0 });
      expect(mgr.getConfig().dailyLimitUsd).toBe(20.0);
    });

    it("emits budget:config_updated event", () => {
      mgr.updateConfig({ dailyLimitUsd: 5.0 });
      const ev = bus.events.find((e) => e.event === "budget:config_updated");
      expect(ev).toBeDefined();
      expect((ev!.payload as { config: { dailyLimitUsd: number } }).config.dailyLimitUsd).toBe(5.0);
    });

    it("resets warning flags after update", () => {
      mgr.updateConfig({ dailyLimitUsd: 10.0, warnPct: 0.5 });
      mgr.recordCost(6.0, "daemon", {});
      mgr.checkAndEmitEvents();
      // warning should have fired
      expect(bus.events.some((e) => e.event === "budget:warning")).toBe(true);

      // Now update config — flags reset
      mgr.updateConfig({ warnPct: 0.9 });
      // Clear previous events for clarity
      bus.events.length = 0;
      // 6 / 10 = 0.6, which is below new warnPct 0.9 — no warning
      mgr.checkAndEmitEvents();
      expect(bus.events.filter((e) => e.event === "budget:warning")).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // resetWarningFlags
  // -------------------------------------------------------------------------

  describe("resetWarningFlags", () => {
    it("allows warning to re-fire after manual reset", () => {
      mgr.updateConfig({ dailyLimitUsd: 10.0, warnPct: 0.5 });
      mgr.recordCost(6.0, "daemon", {});
      mgr.checkAndEmitEvents();
      expect(bus.events.filter((e) => e.event === "budget:warning")).toHaveLength(1);

      mgr.resetWarningFlags();
      mgr.checkAndEmitEvents();
      expect(bus.events.filter((e) => e.event === "budget:warning")).toHaveLength(2);
    });
  });
});
