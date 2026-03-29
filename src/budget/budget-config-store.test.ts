import { describe, it, expect, beforeEach, vi } from "vitest";
import { BudgetConfigStore } from "./budget-config-store.js";
import { DEFAULT_BUDGET_CONFIG } from "./budget-types.js";

describe("BudgetConfigStore", () => {
  let mockStorage: {
    getBudgetConfig: ReturnType<typeof vi.fn>;
    setBudgetConfig: ReturnType<typeof vi.fn>;
    getAllBudgetConfig: ReturnType<typeof vi.fn>;
  };
  let store: BudgetConfigStore;

  beforeEach(() => {
    mockStorage = {
      getBudgetConfig: vi.fn().mockReturnValue(undefined),
      setBudgetConfig: vi.fn(),
      getAllBudgetConfig: vi.fn().mockReturnValue({}),
    };
    delete process.env.STRADA_BUDGET_DAILY_USD;
    delete process.env.STRADA_BUDGET_MONTHLY_USD;
    delete process.env.STRADA_BUDGET_WARN_PCT;
    delete process.env.STRADA_DAEMON_DAILY_BUDGET;
    delete process.env.AGENT_DEFAULT_BUDGET_USD;
    delete process.env.SUPERVISOR_VERIFICATION_BUDGET_PCT;
    store = new BudgetConfigStore(mockStorage as never);
  });

  it("returns defaults when no overrides exist", () => {
    const config = store.getConfig();
    expect(config.dailyLimitUsd).toBe(DEFAULT_BUDGET_CONFIG.dailyLimitUsd);
    expect(config.monthlyLimitUsd).toBe(DEFAULT_BUDGET_CONFIG.monthlyLimitUsd);
    expect(config.warnPct).toBe(0.8);
    expect(config.subLimits.agentDefaultUsd).toBe(5.0);
  });

  it("reads env vars as fallback", () => {
    process.env.STRADA_BUDGET_DAILY_USD = "25";
    store = new BudgetConfigStore(mockStorage as never);
    const config = store.getConfig();
    expect(config.dailyLimitUsd).toBe(25);
  });

  it("portal override takes priority over env var", () => {
    process.env.STRADA_BUDGET_DAILY_USD = "25";
    mockStorage.getAllBudgetConfig.mockReturnValue({ dailyLimitUsd: "50" });
    store = new BudgetConfigStore(mockStorage as never);
    const config = store.getConfig();
    expect(config.dailyLimitUsd).toBe(50);
  });

  it("updateConfig persists to storage", () => {
    store.updateConfig({ dailyLimitUsd: 10 });
    expect(mockStorage.setBudgetConfig).toHaveBeenCalledWith("dailyLimitUsd", "10");
  });

  it("validates warnPct range (too high)", () => {
    expect(() => store.updateConfig({ warnPct: 1.5 })).toThrow();
  });

  it("validates warnPct range (too low)", () => {
    expect(() => store.updateConfig({ warnPct: 0.05 })).toThrow();
  });

  it("invalidates cache after updateConfig", () => {
    mockStorage.getAllBudgetConfig.mockReturnValue({});
    store.getConfig(); // populates cache
    mockStorage.getAllBudgetConfig.mockReturnValue({ dailyLimitUsd: "42" });
    store.updateConfig({ monthlyLimitUsd: 100 }); // should invalidate
    const config = store.getConfig();
    expect(config.dailyLimitUsd).toBe(42);
  });

  it("reads sub-limits from env vars", () => {
    process.env.AGENT_DEFAULT_BUDGET_USD = "8";
    store = new BudgetConfigStore(mockStorage as never);
    expect(store.getConfig().subLimits.agentDefaultUsd).toBe(8);
  });

  it("persists sub-limit updates", () => {
    store.updateConfig({ subLimits: { daemonDailyUsd: 15 } } as never);
    expect(mockStorage.setBudgetConfig).toHaveBeenCalledWith("subLimits.daemonDailyUsd", "15");
  });
});
