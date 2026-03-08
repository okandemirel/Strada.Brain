/**
 * BudgetTracker
 *
 * Tracks LLM costs for daemon-initiated calls in a rolling 24-hour window.
 * Persisted in SQLite via DaemonStorage. Provides warning/exceeded thresholds
 * so the heartbeat loop can skip LLM triggers when budget is exhausted.
 *
 * Budget scope is daemon-only. User LLM calls have their own rate limiter.
 *
 * Requirements: SEC-05 (Daily LLM budget cap)
 */

import type { DaemonStorage } from "../daemon-storage.js";
import type { DaemonBudgetConfig } from "../daemon-types.js";

/** 24 hours in milliseconds */
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface BudgetUsage {
  usedUsd: number;
  limitUsd: number | undefined;
  pct: number;
}

export class BudgetTracker {
  private readonly storage: DaemonStorage;
  private readonly config: DaemonBudgetConfig;

  constructor(storage: DaemonStorage, config: DaemonBudgetConfig) {
    this.storage = storage;
    this.config = config;
  }

  /**
   * Record an LLM cost entry with the current timestamp.
   */
  recordCost(
    costUsd: number,
    opts?: {
      model?: string;
      tokensIn?: number;
      tokensOut?: number;
      triggerName?: string;
    },
  ): void {
    this.storage.insertBudgetEntry({
      costUsd,
      model: opts?.model,
      tokensIn: opts?.tokensIn,
      tokensOut: opts?.tokensOut,
      triggerName: opts?.triggerName,
      timestamp: Date.now(),
    });
  }

  /**
   * Get current budget usage within the rolling 24-hour window.
   *
   * If dailyBudgetUsd is undefined (no budget configured), pct returns 0
   * (unlimited for non-daemon usage).
   */
  getUsage(): BudgetUsage {
    const windowStart = Date.now() - ROLLING_WINDOW_MS;
    const usedUsd = this.storage.sumBudgetSince(windowStart);
    const limitUsd = this.config.dailyBudgetUsd;

    const pct =
      limitUsd !== undefined && limitUsd > 0 ? usedUsd / limitUsd : 0;

    return { usedUsd, limitUsd, pct };
  }

  /**
   * Returns true when usage >= 100% of dailyBudgetUsd.
   * Returns false if dailyBudgetUsd is undefined (no limit).
   */
  isExceeded(): boolean {
    if (this.config.dailyBudgetUsd === undefined) return false;
    return this.getUsage().pct >= 1.0;
  }

  /**
   * Returns true when usage >= warnPct threshold.
   */
  isWarning(): boolean {
    return this.getUsage().pct >= this.config.warnPct;
  }

  /**
   * Clear all budget entries (manual reset via CLI).
   */
  resetBudget(): void {
    this.storage.clearBudgetEntries();
  }
}
