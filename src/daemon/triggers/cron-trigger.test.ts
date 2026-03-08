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
