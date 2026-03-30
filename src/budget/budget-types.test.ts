import { describe, it, expect } from "vitest";
import {
  isBudgetSource,
  toBudgetUsage,
  DEFAULT_BUDGET_CONFIG,
  BUDGET_SOURCES,
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

  it("returns pct=0 when limitUsd is 0 (unlimited)", () => {
    const usage = toBudgetUsage(5, 0);
    expect(usage.pct).toBe(0);
    expect(usage.usedUsd).toBe(5);
    expect(usage.limitUsd).toBe(0);
  });

  it("handles over-budget (15/10 = 1.5)", () => {
    const usage = toBudgetUsage(15, 10);
    expect(usage.pct).toBeCloseTo(1.5);
  });
});

describe("DEFAULT_BUDGET_CONFIG", () => {
  it("has dailyLimitUsd=0", () => {
    expect(DEFAULT_BUDGET_CONFIG.dailyLimitUsd).toBe(0);
  });

  it("has monthlyLimitUsd=0", () => {
    expect(DEFAULT_BUDGET_CONFIG.monthlyLimitUsd).toBe(0);
  });

  it("has agentDefaultUsd=5.0", () => {
    expect(DEFAULT_BUDGET_CONFIG.subLimits.agentDefaultUsd).toBe(5.0);
  });

  it("has verificationPct=0.15", () => {
    expect(DEFAULT_BUDGET_CONFIG.subLimits.verificationPct).toBe(0.15);
  });
});
