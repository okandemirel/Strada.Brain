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

export interface UnifiedBudgetConfig {
  readonly dailyLimitUsd: number;
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
   * portal users can retune without a process restart. Unset or <= 0 → fall back
   * to TaskConfig default.
   */
  readonly interactiveTokenBudget?: number;
}

export const DEFAULT_BUDGET_CONFIG: UnifiedBudgetConfig = {
  dailyLimitUsd: 0,
  monthlyLimitUsd: 0,
  warnPct: 0.8,
  subLimits: {
    daemonDailyUsd: 0,
    agentDefaultUsd: 5.0,
    verificationPct: 0.15,
  },
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
  const pct = limitUsd === 0 ? 0 : usedUsd / limitUsd;
  return { usedUsd, limitUsd, pct };
}
