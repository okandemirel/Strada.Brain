import { describe, it, expect, beforeEach } from "vitest";
import { TriggerDeduplicator } from "./trigger-deduplicator.js";

describe("TriggerDeduplicator", () => {
  let dedup: TriggerDeduplicator;

  beforeEach(() => {
    dedup = new TriggerDeduplicator(300_000); // 5 min global window
  });

  // =========================================================================
  // Basic: first call not suppressed
  // =========================================================================

  it("does not suppress the first call for a trigger", () => {
    const now = Date.now();
    expect(dedup.shouldSuppress("trigger-a", "action-content", now, 60_000)).toBe(false);
  });

  // =========================================================================
  // Per-trigger cooldown
  // =========================================================================

  it("suppresses same trigger within cooldown with reason 'cooldown'", () => {
    const now = Date.now();
    dedup.recordFired("trigger-a", "content-1", now);

    expect(dedup.shouldSuppress("trigger-a", "content-2", now + 30_000, 60_000)).toBe(true);
    expect(dedup.getSuppressionReason()).toBe("cooldown");
  });

  it("does not suppress same trigger after cooldown expires", () => {
    const now = Date.now();
    dedup.recordFired("trigger-a", "content-1", now);

    expect(dedup.shouldSuppress("trigger-a", "content-2", now + 61_000, 60_000)).toBe(false);
  });

  it("does not suppress different trigger even if within cooldown period", () => {
    const now = Date.now();
    dedup.recordFired("trigger-a", "content-1", now);

    expect(dedup.shouldSuppress("trigger-b", "content-different", now + 10_000, 60_000)).toBe(false);
  });

  // =========================================================================
  // Cross-trigger content dedup
  // =========================================================================

  it("suppresses different trigger with same content within global window", () => {
    const now = Date.now();
    dedup.recordFired("trigger-a", "same-content", now);

    expect(dedup.shouldSuppress("trigger-b", "same-content", now + 10_000, 60_000)).toBe(true);
    expect(dedup.getSuppressionReason()).toBe("content_duplicate");
  });

  it("does not suppress different trigger with different content", () => {
    const now = Date.now();
    dedup.recordFired("trigger-a", "content-1", now);

    expect(dedup.shouldSuppress("trigger-b", "content-2", now + 10_000, 60_000)).toBe(false);
  });

  it("does not suppress content after global window expires", () => {
    const now = Date.now();
    dedup.recordFired("trigger-a", "same-content", now);

    // 5 min + 1ms later
    expect(dedup.shouldSuppress("trigger-b", "same-content", now + 300_001, 60_000)).toBe(false);
  });

  // =========================================================================
  // Zero cooldown / zero global window
  // =========================================================================

  it("with zero cooldown, only content dedup applies", () => {
    const now = Date.now();
    dedup.recordFired("trigger-a", "content-1", now);

    // Same trigger, zero cooldown => not suppressed (cooldown is 0)
    expect(dedup.shouldSuppress("trigger-a", "content-different", now + 100, 0)).toBe(false);

    // Same content, different trigger, zero cooldown => still content dedup
    expect(dedup.shouldSuppress("trigger-b", "content-1", now + 100, 0)).toBe(true);
    expect(dedup.getSuppressionReason()).toBe("content_duplicate");
  });

  it("with zero global window, only cooldown applies", () => {
    const zeroWindowDedup = new TriggerDeduplicator(0);
    const now = Date.now();
    zeroWindowDedup.recordFired("trigger-a", "content-1", now);

    // Same content, different trigger => not suppressed (global window is 0)
    expect(zeroWindowDedup.shouldSuppress("trigger-b", "content-1", now + 100, 60_000)).toBe(false);

    // Same trigger within cooldown => suppressed
    expect(zeroWindowDedup.shouldSuppress("trigger-a", "content-2", now + 100, 60_000)).toBe(true);
    expect(zeroWindowDedup.getSuppressionReason()).toBe("cooldown");
  });

  // =========================================================================
  // reset() and resetTrigger()
  // =========================================================================

  it("reset() clears all state", () => {
    const now = Date.now();
    dedup.recordFired("trigger-a", "content-1", now);
    dedup.recordFired("trigger-b", "content-2", now);

    dedup.reset();

    // Nothing suppressed after reset
    expect(dedup.shouldSuppress("trigger-a", "content-1", now + 100, 60_000)).toBe(false);
    expect(dedup.shouldSuppress("trigger-b", "content-2", now + 100, 60_000)).toBe(false);

    const stats = dedup.getStats();
    expect(stats.totalSuppressed).toBe(0);
    expect(stats.byCooldown).toBe(0);
    expect(stats.byContentDupe).toBe(0);
  });

  it("resetTrigger() clears only the specified trigger", () => {
    const now = Date.now();
    dedup.recordFired("trigger-a", "content-a", now);
    dedup.recordFired("trigger-b", "content-b", now);

    dedup.resetTrigger("trigger-a");

    // trigger-a no longer suppressed by cooldown
    expect(dedup.shouldSuppress("trigger-a", "content-new", now + 100, 60_000)).toBe(false);

    // trigger-b still suppressed by cooldown
    expect(dedup.shouldSuppress("trigger-b", "content-new", now + 100, 60_000)).toBe(true);
  });

  // =========================================================================
  // Stats tracking
  // =========================================================================

  it("tracks suppression stats correctly", () => {
    const now = Date.now();

    // Fire trigger-a
    dedup.recordFired("trigger-a", "content-1", now);

    // Suppress by cooldown
    dedup.shouldSuppress("trigger-a", "content-different", now + 100, 60_000);

    // Suppress by content dupe
    dedup.shouldSuppress("trigger-b", "content-1", now + 100, 60_000);

    const stats = dedup.getStats();
    expect(stats.totalSuppressed).toBe(2);
    expect(stats.byCooldown).toBe(1);
    expect(stats.byContentDupe).toBe(1);
  });

  it("does not count non-suppressed checks in stats", () => {
    const now = Date.now();
    dedup.shouldSuppress("trigger-a", "content-1", now, 60_000);

    const stats = dedup.getStats();
    expect(stats.totalSuppressed).toBe(0);
  });

  // =========================================================================
  // Lazy cleanup
  // =========================================================================

  it("lazy cleanup removes expired entries from both maps", () => {
    const now = Date.now();

    // Record many triggers
    for (let i = 0; i < 50; i++) {
      dedup.recordFired(`trigger-${i}`, `content-${i}`, now);
    }

    // Check suppression much later (all entries should be cleaned up)
    const later = now + 400_000; // beyond both cooldown and global window
    const result = dedup.shouldSuppress("trigger-0", "content-0", later, 60_000);
    expect(result).toBe(false);
  });

  // =========================================================================
  // Large volume test (memory leak prevention)
  // =========================================================================

  it("handles 100+ entries without memory leak from cleanup", () => {
    const now = Date.now();

    // Fire 120 unique triggers
    for (let i = 0; i < 120; i++) {
      dedup.recordFired(`trigger-${i}`, `unique-content-${i}`, now + i);
    }

    // After global window expires, check suppression to trigger cleanup
    const later = now + 400_000;
    const result = dedup.shouldSuppress("trigger-new", "new-content", later, 60_000);
    expect(result).toBe(false);

    // Stats should reflect any suppressions that occurred
    const stats = dedup.getStats();
    expect(stats.totalSuppressed).toBe(0);
  });

  // =========================================================================
  // Cooldown takes priority over content dedup
  // =========================================================================

  it("cooldown check runs before content dedup", () => {
    const now = Date.now();
    dedup.recordFired("trigger-a", "same-content", now);

    // Same trigger + same content within cooldown => cooldown reason (not content_duplicate)
    expect(dedup.shouldSuppress("trigger-a", "same-content", now + 100, 60_000)).toBe(true);
    expect(dedup.getSuppressionReason()).toBe("cooldown");
  });

  // =========================================================================
  // getSuppressionReason after non-suppressed check
  // =========================================================================

  it("getSuppressionReason returns null after non-suppressed check", () => {
    const now = Date.now();
    dedup.shouldSuppress("trigger-a", "content", now, 60_000);
    expect(dedup.getSuppressionReason()).toBeNull();
  });
});
