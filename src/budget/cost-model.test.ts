import { describe, it, expect } from "vitest";
import { estimateCost, getProviderCosts, DEFAULT_COST } from "./cost-model.js";

describe("estimateCost", () => {
  it("computes claude cost correctly", () => {
    // (1000 * 3.0 + 500 * 15.0) / 1_000_000 = 0.0105
    expect(estimateCost(1000, 500, "claude")).toBeCloseTo(0.0105);
  });

  it("returns 0 for ollama (free)", () => {
    expect(estimateCost(1000, 500, "ollama")).toBe(0);
  });

  it("uses default cost for unknown providers", () => {
    // (1000 * 2.0 + 500 * 10.0) / 1_000_000 = 0.007
    expect(estimateCost(1000, 500, "unknown-provider")).toBeCloseTo(0.007);
  });
});

describe("getProviderCosts", () => {
  it("returns deepseek rates", () => {
    expect(getProviderCosts("deepseek")).toEqual({ input: 0.14, output: 0.28 });
  });

  it("returns default rates for nonexistent provider", () => {
    expect(getProviderCosts("nonexistent")).toEqual(DEFAULT_COST);
  });
});
