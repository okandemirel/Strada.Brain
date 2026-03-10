import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { QuietHoursManager } from "./quiet-hours.js";
import { DaemonStorage } from "../daemon-storage.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { QuietHoursConfig } from "./notification-types.js";

describe("QuietHoursManager", () => {
  let storage: DaemonStorage;
  let tmpDir: string;

  const makeConfig = (overrides: Partial<QuietHoursConfig> = {}): QuietHoursConfig => ({
    enabled: true,
    startHour: 22,
    endHour: 8,
    timezone: "UTC",
    bufferMax: 100,
    ...overrides,
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "quiet-hours-test-"));
    storage = new DaemonStorage(join(tmpDir, "daemon.db"));
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("isQuietHours()", () => {
    it("returns true for 23:00 when range is 22:00-08:00 (overnight)", () => {
      const mgr = new QuietHoursManager({ config: makeConfig(), storage });
      // 23:00 UTC
      const date = new Date("2026-03-10T23:00:00Z");
      expect(mgr.isQuietHours(date)).toBe(true);
    });

    it("returns false for 10:00 when range is 22:00-08:00", () => {
      const mgr = new QuietHoursManager({ config: makeConfig(), storage });
      const date = new Date("2026-03-10T10:00:00Z");
      expect(mgr.isQuietHours(date)).toBe(false);
    });

    it("returns true for 02:00 when range is 22:00-08:00 (overnight past midnight)", () => {
      const mgr = new QuietHoursManager({ config: makeConfig(), storage });
      const date = new Date("2026-03-10T02:00:00Z");
      expect(mgr.isQuietHours(date)).toBe(true);
    });

    it("returns false when disabled (enabled: false)", () => {
      const mgr = new QuietHoursManager({
        config: makeConfig({ enabled: false }),
        storage,
      });
      const date = new Date("2026-03-10T23:00:00Z");
      expect(mgr.isQuietHours(date)).toBe(false);
    });
  });

  describe("shouldBypass()", () => {
    it("returns true for critical urgency", () => {
      const mgr = new QuietHoursManager({ config: makeConfig(), storage });
      expect(mgr.shouldBypass("critical")).toBe(true);
    });

    it("returns false for high urgency", () => {
      const mgr = new QuietHoursManager({ config: makeConfig(), storage });
      expect(mgr.shouldBypass("high")).toBe(false);
    });

    it("returns false for low urgency", () => {
      const mgr = new QuietHoursManager({ config: makeConfig(), storage });
      expect(mgr.shouldBypass("low")).toBe(false);
    });
  });

  describe("bufferNotification()", () => {
    it("persists to SQLite via DaemonStorage", () => {
      const mgr = new QuietHoursManager({ config: makeConfig(), storage });
      mgr.bufferNotification({
        level: "medium",
        title: "Budget warning",
        message: "Budget at 80%",
        actionHint: "Run: strata daemon budget reset",
        sourceEvent: "daemon:budget_warning",
        timestamp: Date.now(),
      });
      const buffered = storage.getBufferedNotifications();
      expect(buffered).toHaveLength(1);
      expect(buffered[0].title).toBe("Budget warning");
    });

    it("prunes buffer when full, protecting high/critical", () => {
      const mgr = new QuietHoursManager({
        config: makeConfig({ bufferMax: 3 }),
        storage,
      });

      // Insert 2 low + 1 high
      mgr.bufferNotification({ level: "low", title: "L1", message: "m", timestamp: 1 });
      mgr.bufferNotification({ level: "low", title: "L2", message: "m", timestamp: 2 });
      mgr.bufferNotification({ level: "high", title: "H1", message: "m", timestamp: 3 });

      // 4th notification should trigger prune
      mgr.bufferNotification({ level: "low", title: "L3", message: "m", timestamp: 4 });

      const buffered = storage.getBufferedNotifications();
      expect(buffered).toHaveLength(3);
      // High should still be there
      expect(buffered.some((n) => n.title === "H1")).toBe(true);
    });
  });

  describe("drainBuffer()", () => {
    it("returns all buffered sorted by urgency (critical first) then timestamp", () => {
      const mgr = new QuietHoursManager({ config: makeConfig(), storage });

      mgr.bufferNotification({ level: "low", title: "L1", message: "m", timestamp: 100 });
      mgr.bufferNotification({ level: "high", title: "H1", message: "m", timestamp: 200 });
      mgr.bufferNotification({ level: "low", title: "L2", message: "m", timestamp: 300 });
      mgr.bufferNotification({ level: "critical", title: "C1", message: "m", timestamp: 150 });

      const drained = mgr.drainBuffer();
      expect(drained).toHaveLength(4);
      // Critical first, then high, then low in timestamp order
      expect(drained[0].title).toBe("C1");
      expect(drained[1].title).toBe("H1");
      expect(drained[2].title).toBe("L1");
      expect(drained[3].title).toBe("L2");

      // Buffer should be empty after drain
      expect(storage.getBufferedNotifications()).toHaveLength(0);
    });
  });
});
