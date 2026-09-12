import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CronTrigger } from "./cron-trigger.js";
import type { TriggerMetadata } from "../daemon-types.js";

describe("CronTrigger", () => {
  const metadata: TriggerMetadata = {
    name: "test-trigger",
    description: "Test trigger",
    type: "cron",
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // shouldFire
  // =========================================================================

  it("shouldFire returns true when croner matches the current minute", () => {
    // Set time to 9:00 AM on a Monday
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));
    const trigger = new CronTrigger(metadata, "0 9 * * *", "UTC");
    expect(trigger.shouldFire(new Date())).toBe(true);
  });

  /**
   * Codex round AG#12: the match was against the CURRENT MINUTE alone, so an
   * evaluation at 02:59:50 and the next at 03:01:10 — a busy foreground, a
   * restart, a slow tick — skipped "0 3 * * *" entirely and the work never
   * ran.
   */
  it("fires for an occurrence that fell between two looks (Codex 2026-09-13 AG#12)", () => {
    vi.setSystemTime(new Date("2026-03-09T02:59:00Z"));
    const trigger = new CronTrigger(metadata, "0 3 * * *", "UTC");
    // 02:59:50 — not due yet, and this look is remembered.
    expect(trigger.shouldFire(new Date("2026-03-09T02:59:50Z"))).toBe(false);
    // 03:01:10 — the 03:00 occurrence is in the past, and nobody looked in it.
    expect(trigger.shouldFire(new Date("2026-03-09T03:01:10Z"))).toBe(true);
  });

  it("does not fire for an occurrence that has not happened, nor twice for one", () => {
    vi.setSystemTime(new Date("2026-03-09T01:00:00Z"));
    const trigger = new CronTrigger(metadata, "0 3 * * *", "UTC");
    expect(trigger.shouldFire(new Date("2026-03-09T02:00:00Z"))).toBe(false);
    expect(trigger.shouldFire(new Date("2026-03-09T02:30:00Z"))).toBe(false);
    // It fires once for the missed occurrence…
    expect(trigger.shouldFire(new Date("2026-03-09T03:01:10Z"))).toBe(true);
    trigger.onFired(new Date("2026-03-09T03:01:10Z"));
    // …and not again on the next look.
    expect(trigger.shouldFire(new Date("2026-03-09T03:02:10Z"))).toBe(false);
  });

  it("a daemon that was down for a week runs the last occurrence, not every one", () => {
    vi.setSystemTime(new Date("2026-03-01T02:50:00Z"));
    const trigger = new CronTrigger(metadata, "0 3 * * *", "UTC");
    expect(trigger.shouldFire(new Date("2026-03-01T03:00:30Z"))).toBe(true);
    trigger.onFired(new Date("2026-03-01T03:00:30Z"));
    // Seven days later: one catch-up, bounded by the window.
    expect(trigger.shouldFire(new Date("2026-03-09T09:00:00Z"))).toBe(false);
    expect(trigger.shouldFire(new Date("2026-03-10T03:00:20Z"))).toBe(true);
  });

  it("shouldFire returns false when croner does not match", () => {
    // Set time to 10:30 AM -- cron is for 9:00
    vi.setSystemTime(new Date("2026-03-09T10:30:00Z"));
    const trigger = new CronTrigger(metadata, "0 9 * * *", "UTC");
    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  it("shouldFire returns false if already fired in the same minute (prevents double-fire)", () => {
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));
    const trigger = new CronTrigger(metadata, "0 9 * * *", "UTC");

    // First check -- should fire
    expect(trigger.shouldFire(new Date())).toBe(true);

    // Simulate fire
    trigger.onFired(new Date());

    // 30 seconds later (still same minute)
    vi.setSystemTime(new Date("2026-03-09T09:00:30Z"));
    expect(trigger.shouldFire(new Date())).toBe(false);
  });

  // =========================================================================
  // onFired
  // =========================================================================

  it("onFired updates lastFired, subsequent shouldFire for same minute returns false", () => {
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));
    const trigger = new CronTrigger(metadata, "0 9 * * *", "UTC");

    trigger.onFired(new Date());

    // Same minute
    vi.setSystemTime(new Date("2026-03-09T09:00:45Z"));
    expect(trigger.shouldFire(new Date())).toBe(false);

    // Next matching minute (next day at 9:00)
    vi.setSystemTime(new Date("2026-03-10T09:00:00Z"));
    expect(trigger.shouldFire(new Date())).toBe(true);
  });

  // =========================================================================
  // getNextRun
  // =========================================================================

  it("getNextRun returns the next scheduled time from croner", () => {
    vi.setSystemTime(new Date("2026-03-09T08:30:00Z"));
    const trigger = new CronTrigger(metadata, "0 9 * * *", "UTC");
    const nextRun = trigger.getNextRun();
    expect(nextRun).not.toBeNull();
    expect(nextRun!.getUTCHours()).toBe(9);
    expect(nextRun!.getUTCMinutes()).toBe(0);
  });

  // =========================================================================
  // getState
  // =========================================================================

  it("getState returns active by default", () => {
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));
    const trigger = new CronTrigger(metadata, "0 9 * * *", "UTC");
    expect(trigger.getState()).toBe("active");
  });

  // =========================================================================
  // Timezone
  // =========================================================================

  it("timezone parameter is passed to croner", () => {
    // At 09:00 UTC, which is 12:00 in Europe/Istanbul (UTC+3)
    vi.setSystemTime(new Date("2026-03-09T09:00:00Z"));
    const utcTrigger = new CronTrigger(metadata, "0 9 * * *", "UTC");
    const istanbulTrigger = new CronTrigger(metadata, "0 12 * * *", "Europe/Istanbul");

    // Both should fire: UTC trigger at 9:00 UTC, Istanbul trigger at 12:00 Istanbul = 09:00 UTC
    expect(utcTrigger.shouldFire(new Date())).toBe(true);
    expect(istanbulTrigger.shouldFire(new Date())).toBe(true);
  });

  // =========================================================================
  // Invalid cron expression
  // =========================================================================

  it("constructor with invalid cron expression throws", () => {
    expect(() => {
      new CronTrigger(metadata, "not-valid-cron", "UTC");
    }).toThrow();
  });
});
