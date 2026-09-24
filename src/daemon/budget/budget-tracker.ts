/**
 * BudgetTracker
 *
 * Tracks LLM costs for daemon-initiated calls in a rolling 24-hour window.
 * Persisted in SQLite via DaemonStorage. Provides warning/exceeded thresholds
 * so the heartbeat loop can skip LLM triggers when budget is exhausted.
 *
 * Budget scope follows the limit: `budget_entries` is shared by every spender
 * (daemon, chat, agent, verification — all written by UnifiedBudgetManager),
 * so a dedicated daemon sub-limit (`limitScope: "daemon"`) is measured against
 * daemon-source spend only, while the shared-wallet fallback
 * (`limitScope: "system"`) is measured against every source.
 *
 * Requirements: SEC-05 (Daily LLM budget cap)
 */

import type { DaemonStorage } from "../daemon-storage.js";
import type { DaemonBudgetConfig, DaemonBudgetScope } from "../daemon-types.js";

/** 24 hours in milliseconds */
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** daemon_state key: when `strada daemon budget reset` last ran (epoch ms). */
export const DAEMON_BUDGET_RESET_KEY = "daemon_budget_reset_at";

export interface BudgetUsage {
  usedUsd: number;
  limitUsd: number | undefined;
  pct: number;
  /** Which spend `usedUsd` sums — names what the percentage measured. */
  scope?: DaemonBudgetScope;
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
    // A manual reset moves the start of the daemon's window; the ledger itself
    // is left intact (see resetBudget).
    const windowStart = Math.max(Date.now() - ROLLING_WINDOW_MS, this.resetFloor());
    // Audited 2026-09-02: this summed EVERY source against the limit, so with a
    // dedicated STRADA_DAEMON_DAILY_BUDGET=5 ordinary chat spend of $5 read as
    // pct=1.0 and stopped the trigger loop and AgentCore for a daemon that had
    // spent $0. The measurement now matches the scope of the limit it is
    // compared against.
    const scope: DaemonBudgetScope = this.config.limitScope ?? "system";
    const usedUsd = scope === "daemon"
      ? this.storage.sumBudgetForSource("daemon", windowStart)
      : this.storage.sumBudgetSince(windowStart);
    const limitUsd = this.config.dailyBudgetUsd;

    const pct =
      limitUsd !== undefined && limitUsd > 0 ? usedUsd / limitUsd : 0;

    return { usedUsd, limitUsd, pct, scope };
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
   * Reset the daemon's budget counter (manual reset via CLI).
   *
   * `budget_entries` is the ledger every spender shares: deleting it (as this
   * did) also zeroed the global wallet, the chat and agent allowances and
   * every per-campaign and per-task cost. The reset is a marker instead:
   * this tracker counts only spend recorded after it.
   */
  resetBudget(): void {
    const now = Date.now();
    this.storage.setDaemonState(DAEMON_BUDGET_RESET_KEY, String(now));
    this.resetAtMs = now;
  }

  private resetAtMs: number | undefined;

  /** First timestamp the daemon's window may count (0 when never reset). */
  private resetFloor(): number {
    if (this.resetAtMs === undefined) {
      const stored = Number(this.storage.getDaemonState(DAEMON_BUDGET_RESET_KEY));
      this.resetAtMs = Number.isFinite(stored) ? stored : 0;
    }
    // Spend recorded in the reset's own millisecond belongs to before it.
    return this.resetAtMs > 0 ? this.resetAtMs + 1 : 0;
  }
}
