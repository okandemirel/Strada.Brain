import { describe, it, expect } from "vitest";
import {
  isBudgetSource,
  toBudgetUsage,
  DEFAULT_BUDGET_CONFIG,
  BUDGET_SOURCES,
  NO_BUDGET_LIMIT,
  hasBudgetLimit,
} from "./budget-types.js";

describe("isBudgetSource", () => {
  it("accepts all 4 valid sources", () => {
    for (const source of BUDGET_SOURCES) {
      expect(isBudgetSource(source)).toBe(true);
    }
  });

  it("rejects unknown string", () => {
    expect(isBudgetSource("unknown")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isBudgetSource("")).toBe(false);
  });
});

describe("toBudgetUsage", () => {
  it("computes pct correctly (3.5/10 = 0.35)", () => {
    const usage = toBudgetUsage(3.5, 10);
    expect(usage.usedUsd).toBe(3.5);
    expect(usage.limitUsd).toBe(10);
    expect(usage.pct).toBeCloseTo(0.35);
  });

  it("a limit of ZERO with spend is fully spent; NO limit has no share (plan 2.1b)", () => {
    // Zero used to mean "unlimited", so a budget set to zero to stop spending
    // reported 0% of no limit (audit 10.1b).
    const usage = toBudgetUsage(5, 0);
    expect(usage.pct).toBe(1);
    expect(usage.usedUsd).toBe(5);
    expect(usage.limitUsd).toBe(0);
    expect(toBudgetUsage(0, 0).pct).toBe(0);
    expect(toBudgetUsage(5, NO_BUDGET_LIMIT).pct).toBe(0);
  });

  it("handles over-budget (15/10 = 1.5)", () => {
    const usage = toBudgetUsage(15, 10);
    expect(usage.pct).toBeCloseTo(1.5);
  });
});

describe("DEFAULT_BUDGET_CONFIG", () => {
  it("has no daily limit by default (plan 2.1b: -1, not 0)", () => {
    expect(DEFAULT_BUDGET_CONFIG.dailyLimitUsd).toBe(NO_BUDGET_LIMIT);
    expect(hasBudgetLimit(DEFAULT_BUDGET_CONFIG.dailyLimitUsd)).toBe(false);
  });

  it("has no monthly limit by default, and zero IS a limit", () => {
    expect(DEFAULT_BUDGET_CONFIG.monthlyLimitUsd).toBe(NO_BUDGET_LIMIT);
    expect(hasBudgetLimit(0)).toBe(true);
    expect(hasBudgetLimit(2.5)).toBe(true);
  });

  it("has agentDefaultUsd=5.0", () => {
    expect(DEFAULT_BUDGET_CONFIG.subLimits.agentDefaultUsd).toBe(5.0);
  });

  it("has verificationPct=0.15", () => {
    expect(DEFAULT_BUDGET_CONFIG.subLimits.verificationPct).toBe(0.15);
  });
});
