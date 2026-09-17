/**
 * Unified Budget Type System
 *
 * Shared types for the unified budget manager, config store, and API.
 * Replaces fragmented types across daemon, agent, and rate-limiter subsystems.
 */

// ---------------------------------------------------------------------------
// Source types
// ---------------------------------------------------------------------------

export type BudgetSource = "daemon" | "agent" | "chat" | "verification";

export const BUDGET_SOURCES: readonly BudgetSource[] = [
  "daemon",
  "agent",
  "chat",
  "verification",
] as const;

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export interface CostMetadata {
  readonly model?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly triggerName?: string;
  readonly agentId?: string;
  /**
   * Charge this cost against an outstanding in-process reservation
   * (UnifiedBudgetManager.reserve), shrinking the headroom it still holds.
   * Without it a running task is counted twice — once as recorded spend,
   * once as its own untouched estimate (plan 2.12 / audit 03.1 / D20).
   */
  readonly reservationId?: string;
}

// ---------------------------------------------------------------------------
// Usage / snapshot
// ---------------------------------------------------------------------------

export interface BudgetUsage {
  readonly usedUsd: number;
  readonly limitUsd: number;
  readonly pct: number;
}

export interface BudgetSnapshot {
  readonly global: {
    readonly daily: BudgetUsage;
    readonly monthly: BudgetUsage;
  };
  readonly breakdown: {
    readonly daemon: number;
    readonly agents: number;
    readonly chat: number;
    readonly verification: number;
  };
  readonly subLimitStatus: {
    readonly daemonExceeded: boolean;
    readonly agentExceeded: Record<string, boolean>;
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * NO LIMIT, as against a limit of nothing. Zero used to mean "unlimited", so
 * a person who set the daily budget to 0 to stop all spending was told
 * "unlimited" and the daemon spent freely (plan 2.1b / audit 10.1b, the
 * budget half). The convention `interactiveTokenBudget` already uses: -1 is
 * no limit, 0 is a limit of zero — nothing may be spent.
 */
export const NO_BUDGET_LIMIT = -1;

/** Is a configured limit a real ceiling (including zero), rather than "no limit"? */
export function hasBudgetLimit(limitUsd: number): boolean {
  return limitUsd >= 0;
}

export interface UnifiedBudgetConfig {
  /** A ceiling in USD; 0 means nothing may be spent, NO_BUDGET_LIMIT (-1) means no ceiling. */
  readonly dailyLimitUsd: number;
  /** A ceiling in USD; 0 means nothing may be spent, NO_BUDGET_LIMIT (-1) means no ceiling. */
  readonly monthlyLimitUsd: number;
  readonly warnPct: number;
  readonly subLimits: {
    readonly daemonDailyUsd: number;
    readonly agentDefaultUsd: number;
    readonly verificationPct: number;
  };
  /**
   * Absolute input-token budget per interactive/background task iteration loop.
   * When set, live-overrides the static TaskConfig.interactiveTokenBudget so
   * portal users can retune without a process restart. Unset or < 0 → fall back
   * to TaskConfig default. -1 = unlimited.
   */
  readonly interactiveTokenBudget?: number;
  /**
   * Headroom a background task run reserves for itself when it STARTS, in
   * USD, until its real cost is recorded (plan 2.12 / audit 03.1 / D20).
   * Two runs that started on the same remaining dollar both passed
   * canSpend(), which summed recorded spend only. A task that carries its
   * own estimate uses that instead. Unset → DEFAULT_BUDGET_CONFIG's 0.25;
   * 0 disables task reservations. Reservations are in-memory: they hold
   * headroom for work in flight in THIS process and vanish with it.
   */
  readonly taskReservationUsd?: number;
}

export const DEFAULT_BUDGET_CONFIG: UnifiedBudgetConfig = {
  dailyLimitUsd: NO_BUDGET_LIMIT,
  monthlyLimitUsd: NO_BUDGET_LIMIT,
  warnPct: 0.8,
  subLimits: {
    daemonDailyUsd: 0,
    agentDefaultUsd: 5.0,
    verificationPct: 0.15,
  },
  taskReservationUsd: 0.25,
};

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface DailyHistoryEntry {
  readonly date: string;
  readonly daemon: number;
  readonly agents: number;
  readonly chat: number;
  readonly verification: number;
  readonly total: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isBudgetSource(s: string): s is BudgetSource {
  return (BUDGET_SOURCES as readonly string[]).includes(s);
}

export function toBudgetUsage(usedUsd: number, limitUsd: number): BudgetUsage {
  // A limit of ZERO with anything spent is fully spent; no limit has no share.
  const pct = !hasBudgetLimit(limitUsd) ? 0 : limitUsd === 0 ? (usedUsd > 0 ? 1 : 0) : usedUsd / limitUsd;
  return { usedUsd, limitUsd, pct };
}
