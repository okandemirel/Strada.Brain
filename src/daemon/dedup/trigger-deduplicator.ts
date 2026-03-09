/**
 * Trigger Deduplicator
 *
 * Prevents duplicate trigger actions through two mechanisms:
 * 1. Per-trigger cooldown: same trigger cannot fire again within cooldownMs
 * 2. Cross-trigger content dedup: same action content (SHA-256 hash) within
 *    globalWindowMs is suppressed regardless of which trigger produced it
 *
 * Uses lazy cleanup to prevent memory leaks from accumulated entries.
 *
 * Used by: HeartbeatLoop (Plan 03) during trigger evaluation
 */

import { createHash } from "node:crypto";

/** Suppression reason returned after a shouldSuppress() call */
export type SuppressionReason = "cooldown" | "content_duplicate" | null;

/** Deduplication statistics */
export interface DedupStats {
  totalSuppressed: number;
  byCooldown: number;
  byContentDupe: number;
}

/**
 * TriggerDeduplicator suppresses duplicate trigger fires via per-trigger
 * cooldown and cross-trigger content hashing.
 */
export class TriggerDeduplicator {
  private readonly globalWindowMs: number;

  /** Per-trigger last-fired timestamps: triggerName -> epoch ms */
  private readonly lastFired = new Map<string, number>();

  /** Content hash -> epoch ms for cross-trigger dedup */
  private readonly contentHashes = new Map<string, number>();

  /** Last suppression reason (set by shouldSuppress) */
  private lastReason: SuppressionReason = null;

  /** Stats counters */
  private totalSuppressedCount = 0;
  private cooldownCount = 0;
  private contentDupeCount = 0;

  constructor(globalWindowMs: number = 300_000) {
    this.globalWindowMs = globalWindowMs;
  }

  /**
   * Check if a trigger action should be suppressed.
   *
   * @param triggerName - Name of the trigger attempting to fire
   * @param actionContent - The action string (content-hashed for cross-trigger dedup)
   * @param now - Current timestamp in epoch ms
   * @param cooldownMs - Per-trigger cooldown window in ms
   * @returns true if the action should be suppressed
   */
  shouldSuppress(
    triggerName: string,
    actionContent: string,
    now: number,
    cooldownMs: number,
  ): boolean {
    // Lazy cleanup: remove entries older than max window
    this.cleanup(now, cooldownMs);

    // Reset reason
    this.lastReason = null;

    // 1. Per-trigger cooldown check
    if (cooldownMs > 0) {
      const lastTime = this.lastFired.get(triggerName);
      if (lastTime !== undefined && now - lastTime < cooldownMs) {
        this.lastReason = "cooldown";
        this.totalSuppressedCount++;
        this.cooldownCount++;
        return true;
      }
    }

    // 2. Cross-trigger content dedup check
    if (this.globalWindowMs > 0) {
      const hash = this.hashContent(actionContent);
      const lastContent = this.contentHashes.get(hash);
      if (lastContent !== undefined && now - lastContent < this.globalWindowMs) {
        this.lastReason = "content_duplicate";
        this.totalSuppressedCount++;
        this.contentDupeCount++;
        return true;
      }
    }

    return false;
  }

  /**
   * Record that a trigger fired. Call this after successfully processing
   * the trigger action (after shouldSuppress returns false).
   */
  recordFired(triggerName: string, actionContent: string, now: number): void {
    this.lastFired.set(triggerName, now);
    const hash = this.hashContent(actionContent);
    this.contentHashes.set(hash, now);
  }

  /**
   * Get the reason for the last suppression.
   * Returns null if the last check was not suppressed.
   */
  getSuppressionReason(): SuppressionReason {
    return this.lastReason;
  }

  /**
   * Clear all dedup state and reset stats.
   */
  reset(): void {
    this.lastFired.clear();
    this.contentHashes.clear();
    this.lastReason = null;
    this.totalSuppressedCount = 0;
    this.cooldownCount = 0;
    this.contentDupeCount = 0;
  }

  /**
   * Clear cooldown state for a single trigger.
   * Content hashes are NOT cleared (cross-trigger dedup remains).
   */
  resetTrigger(name: string): void {
    this.lastFired.delete(name);
  }

  /**
   * Get suppression statistics.
   */
  getStats(): DedupStats {
    return {
      totalSuppressed: this.totalSuppressedCount,
      byCooldown: this.cooldownCount,
      byContentDupe: this.contentDupeCount,
    };
  }

  /**
   * Compute SHA-256 hash of action content for dedup comparison.
   */
  private hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  /**
   * Lazy cleanup: remove entries from both maps that are older than
   * their respective windows. Called on every shouldSuppress to prevent
   * unbounded memory growth.
   */
  private cleanup(now: number, cooldownMs: number): void {
    const maxWindow = Math.max(this.globalWindowMs, cooldownMs);
    if (maxWindow <= 0) return;

    // Clean lastFired entries
    for (const [key, ts] of this.lastFired) {
      if (now - ts >= maxWindow) {
        this.lastFired.delete(key);
      }
    }

    // Clean content hash entries
    const contentWindow = this.globalWindowMs > 0 ? this.globalWindowMs : maxWindow;
    for (const [key, ts] of this.contentHashes) {
      if (now - ts >= contentWindow) {
        this.contentHashes.delete(key);
      }
    }
  }
}
