import type { UnifiedBudgetConfig } from "./budget-types.js";
import { DEFAULT_BUDGET_CONFIG } from "./budget-types.js";

interface BudgetStorage {
  getBudgetConfig(key: string): string | undefined;
  setBudgetConfig(key: string, value: string): void;
  getAllBudgetConfig(): Record<string, string>;
}

function parseNum(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = parseFloat(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export class BudgetConfigStore {
  private readonly storage: BudgetStorage;
  private cached: UnifiedBudgetConfig | null = null;

  constructor(storage: BudgetStorage) {
    this.storage = storage;
  }

  getConfig(): UnifiedBudgetConfig {
    if (this.cached) return this.cached;
    this.cached = this.resolve();
    return this.cached;
  }

  updateConfig(partial: Partial<UnifiedBudgetConfig & { subLimits?: Partial<UnifiedBudgetConfig["subLimits"]> }>): void {
    // Validate warnPct
    if (partial.warnPct !== undefined) {
      if (partial.warnPct < 0.1 || partial.warnPct > 0.99) {
        throw new Error("warnPct must be between 0.1 and 0.99");
      }
    }
    // Validate and persist each field
    if (partial.dailyLimitUsd !== undefined) {
      if (typeof partial.dailyLimitUsd !== "number" || !Number.isFinite(partial.dailyLimitUsd) || partial.dailyLimitUsd < 0) throw new Error("dailyLimitUsd must be a finite number >= 0");
      this.storage.setBudgetConfig("dailyLimitUsd", String(partial.dailyLimitUsd));
    }
    if (partial.monthlyLimitUsd !== undefined) {
      if (typeof partial.monthlyLimitUsd !== "number" || !Number.isFinite(partial.monthlyLimitUsd) || partial.monthlyLimitUsd < 0) throw new Error("monthlyLimitUsd must be a finite number >= 0");
      this.storage.setBudgetConfig("monthlyLimitUsd", String(partial.monthlyLimitUsd));
    }
    if (partial.warnPct !== undefined) {
      this.storage.setBudgetConfig("warnPct", String(partial.warnPct));
    }
    if (partial.subLimits) {
      const sl = partial.subLimits;
      if (sl.daemonDailyUsd !== undefined) {
        if (typeof sl.daemonDailyUsd !== "number" || !Number.isFinite(sl.daemonDailyUsd) || sl.daemonDailyUsd < 0) throw new Error("daemonDailyUsd must be a finite number >= 0");
        this.storage.setBudgetConfig("subLimits.daemonDailyUsd", String(sl.daemonDailyUsd));
      }
      if (sl.agentDefaultUsd !== undefined) {
        if (typeof sl.agentDefaultUsd !== "number" || !Number.isFinite(sl.agentDefaultUsd) || sl.agentDefaultUsd < 0) throw new Error("agentDefaultUsd must be a finite number >= 0");
        this.storage.setBudgetConfig("subLimits.agentDefaultUsd", String(sl.agentDefaultUsd));
      }
      if (sl.verificationPct !== undefined) {
        if (typeof sl.verificationPct !== "number" || !Number.isFinite(sl.verificationPct) || sl.verificationPct < 0 || sl.verificationPct > 1) throw new Error("verificationPct must be a finite number between 0 and 1");
        this.storage.setBudgetConfig("subLimits.verificationPct", String(sl.verificationPct));
      }
    }
    if (partial.interactiveTokenBudget !== undefined) {
      if (
        typeof partial.interactiveTokenBudget !== "number" ||
        !Number.isFinite(partial.interactiveTokenBudget) ||
        partial.interactiveTokenBudget < 0
      ) {
        throw new Error("interactiveTokenBudget must be a finite number >= 0");
      }
      this.storage.setBudgetConfig("interactiveTokenBudget", String(partial.interactiveTokenBudget));
    }
    this.cached = null; // Invalidate cache
  }

  private resolve(): UnifiedBudgetConfig {
    const overrides = this.storage.getAllBudgetConfig();
    const val = (key: string, envKey: string, fallback: number): number =>
      parseNum(overrides[key]) ?? parseNum(process.env[envKey]) ?? fallback;

    // Optional live-override for interactive token budget. Unset → leave undefined
    // so consumers fall back to their static config (TaskConfig.interactiveTokenBudget).
    const interactiveOverride =
      parseNum(overrides["interactiveTokenBudget"]) ??
      parseNum(process.env["STRADA_INTERACTIVE_TOKEN_BUDGET"]);

    return {
      dailyLimitUsd: val("dailyLimitUsd", "STRADA_BUDGET_DAILY_USD", DEFAULT_BUDGET_CONFIG.dailyLimitUsd),
      monthlyLimitUsd: val("monthlyLimitUsd", "STRADA_BUDGET_MONTHLY_USD", DEFAULT_BUDGET_CONFIG.monthlyLimitUsd),
      warnPct: val("warnPct", "STRADA_BUDGET_WARN_PCT", DEFAULT_BUDGET_CONFIG.warnPct),
      subLimits: {
        daemonDailyUsd: val("subLimits.daemonDailyUsd", "STRADA_DAEMON_DAILY_BUDGET", DEFAULT_BUDGET_CONFIG.subLimits.daemonDailyUsd),
        agentDefaultUsd: val("subLimits.agentDefaultUsd", "AGENT_DEFAULT_BUDGET_USD", DEFAULT_BUDGET_CONFIG.subLimits.agentDefaultUsd),
        verificationPct: val("subLimits.verificationPct", "SUPERVISOR_VERIFICATION_BUDGET_PCT", DEFAULT_BUDGET_CONFIG.subLimits.verificationPct),
      },
      ...(interactiveOverride !== undefined && interactiveOverride > 0
        ? { interactiveTokenBudget: interactiveOverride }
        : {}),
    };
  }
}
