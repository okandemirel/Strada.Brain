import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BudgetTracker } from "./budget-tracker.js";
import { DaemonStorage } from "../daemon-storage.js";
import type { DaemonBudgetConfig } from "../daemon-types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("BudgetTracker", () => {
  let storage: DaemonStorage;
  let tmpDir: string;
  let tracker: BudgetTracker;
  const defaultConfig: DaemonBudgetConfig = {
    dailyBudgetUsd: 5.0,
    warnPct: 0.8,
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "budget-tracker-test-"));
    const dbPath = join(tmpDir, "daemon.db");
    storage = new DaemonStorage(dbPath);
    storage.initialize();
    tracker = new BudgetTracker(storage, defaultConfig);
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  // =========================================================================
  // getUsage
  // =========================================================================

  describe("getUsage()", () => {
    it("returns zero usage when no entries exist", () => {
      const usage = tracker.getUsage();
      expect(usage.usedUsd).toBe(0);
      expect(usage.limitUsd).toBe(5.0);
      expect(usage.pct).toBe(0);
    });

    it("reflects a single recordCost call", () => {
      tracker.recordCost(1.5);
      const usage = tracker.getUsage();
      expect(usage.usedUsd).toBeCloseTo(1.5, 2);
      expect(usage.limitUsd).toBe(5.0);
      expect(usage.pct).toBeCloseTo(0.3, 2);
    });

    it("accumulates multiple recordCost calls correctly", () => {
      tracker.recordCost(1.0);
      tracker.recordCost(2.0);
      tracker.recordCost(0.5);
      const usage = tracker.getUsage();
      expect(usage.usedUsd).toBeCloseTo(3.5, 2);
      expect(usage.pct).toBeCloseTo(0.7, 2);
    });

    it("returns correct pct as ratio (0.0 to 1.0+)", () => {
      tracker.recordCost(7.5); // 150% of $5 budget
      const usage = tracker.getUsage();
      expect(usage.pct).toBeCloseTo(1.5, 2);
    });

    it("returns pct 0 when dailyBudgetUsd is undefined (unlimited)", () => {
      const unlimitedConfig: DaemonBudgetConfig = {
        dailyBudgetUsd: undefined,
        warnPct: 0.8,
      };
      const unlimitedTracker = new BudgetTracker(storage, unlimitedConfig);
      unlimitedTracker.recordCost(100);
      const usage = unlimitedTracker.getUsage();
      expect(usage.pct).toBe(0);
      expect(usage.usedUsd).toBeCloseTo(100, 2);
    });
  });

  // =========================================================================
  // Rolling 24h window
  // =========================================================================

  describe("rolling 24h window", () => {
    it("only includes entries within 24h rolling window (older entries excluded)", () => {
      vi.useFakeTimers();
      const now = Date.now();

      // Entry from 25 hours ago (outside window)
      vi.setSystemTime(now - 25 * 60 * 60 * 1000);
      tracker.recordCost(3.0);

      // Entry from 1 hour ago (inside window)
      vi.setSystemTime(now - 1 * 60 * 60 * 1000);
      tracker.recordCost(1.5);

      // Check at "now"
      vi.setSystemTime(now);
      const usage = tracker.getUsage();
      expect(usage.usedUsd).toBeCloseTo(1.5, 2);
    });
  });

  // =========================================================================
  // isExceeded
  // =========================================================================

  describe("isExceeded()", () => {
    it("returns false when under budget", () => {
      tracker.recordCost(3.0);
      expect(tracker.isExceeded()).toBe(false);
    });

    it("returns true when usage >= 100% of dailyBudgetUsd", () => {
      tracker.recordCost(5.0);
      expect(tracker.isExceeded()).toBe(true);
    });

    it("returns true when usage exceeds budget", () => {
      tracker.recordCost(6.0);
      expect(tracker.isExceeded()).toBe(true);
    });

    it("returns false when dailyBudgetUsd is undefined", () => {
      const unlimitedConfig: DaemonBudgetConfig = {
        dailyBudgetUsd: undefined,
        warnPct: 0.8,
      };
      const unlimitedTracker = new BudgetTracker(storage, unlimitedConfig);
      unlimitedTracker.recordCost(1000);
      expect(unlimitedTracker.isExceeded()).toBe(false);
    });
  });

  // =========================================================================
  // isWarning
  // =========================================================================

  describe("isWarning()", () => {
    it("returns true when usage >= warnPct (80%)", () => {
      tracker.recordCost(4.0); // 80% of $5
      expect(tracker.isWarning()).toBe(true);
    });

    it("returns false when under warnPct", () => {
      tracker.recordCost(3.0); // 60% of $5
      expect(tracker.isWarning()).toBe(false);
    });

    it("returns true when exactly at warnPct", () => {
      tracker.recordCost(4.0); // 80% exactly
      expect(tracker.isWarning()).toBe(true);
    });
  });

  // =========================================================================
  // resetBudget
  // =========================================================================

  describe("resetBudget()", () => {
    it("clears all entries via DaemonStorage.clearBudgetEntries", () => {
      tracker.recordCost(3.0);
      tracker.recordCost(1.5);
      expect(tracker.getUsage().usedUsd).toBeCloseTo(4.5, 2);

      tracker.resetBudget();

      const usage = tracker.getUsage();
      expect(usage.usedUsd).toBe(0);
      expect(usage.pct).toBe(0);
    });
  });

  // =========================================================================
  // recordCost optional params
  // =========================================================================

  describe("recordCost() optional params", () => {
    it("accepts optional model, tokensIn, tokensOut, triggerName", () => {
      // Should not throw
      tracker.recordCost(0.5, {
        model: "gpt-4",
        tokensIn: 100,
        tokensOut: 200,
        triggerName: "my-trigger",
      });
      const usage = tracker.getUsage();
      expect(usage.usedUsd).toBeCloseTo(0.5, 2);
    });
  });

  // =========================================================================
  // Persistence across re-instantiation
  // =========================================================================

  describe("persistence", () => {
    it("budget persists across BudgetTracker re-instantiation (read from same storage)", () => {
      tracker.recordCost(2.5);
      expect(tracker.getUsage().usedUsd).toBeCloseTo(2.5, 2);

      // Create a new tracker with the same storage
      const tracker2 = new BudgetTracker(storage, defaultConfig);
      const usage = tracker2.getUsage();
      expect(usage.usedUsd).toBeCloseTo(2.5, 2);
    });
  });
});
