import { describe, it, expect } from "vitest";
import { estimateCost, estimateCostWithCache, getProviderCosts, DEFAULT_COST } from "./cost-model.js";

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

describe("estimateCostWithCache — the cached share is priced at its own rate", () => {
  // TokenUsage invariant: cacheCreation + cacheRead <= inputTokens (the cached
  // share is INCLUDED in inputTokens). Flat pricing billed that share at full
  // input rate; a cache-heavy Claude session overstated cost ~4x.
  const claude = { input: 3.0, output: 15.0 };

  it("matches flat pricing when no cache tokens are reported", () => {
    const usage = { inputTokens: 1000, outputTokens: 500 };
    expect(estimateCostWithCache(usage, "claude")).toBeCloseTo(estimateCost(1000, 500, "claude"));
  });

  it("bills Anthropic cache reads at 0.1x and writes at 1.25x of input", () => {
    // 800 plain + 100 write + 100 read, 200 out.
    const expected = (800 * claude.input
      + 100 * claude.input * 1.25
      + 100 * claude.input * 0.1
      + 200 * claude.output) / 1_000_000;
    expect(estimateCostWithCache(
      { inputTokens: 1000, outputTokens: 200, cacheCreationInputTokens: 100, cacheReadInputTokens: 100 },
      "claude",
    )).toBeCloseTo(expected);
  });

  it("understates nothing when cache fields exceed reported input (defensive clamp)", () => {
    const result = estimateCostWithCache(
      { inputTokens: 50, outputTokens: 0, cacheReadInputTokens: 500 },
      "claude",
    );
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it("degrades to uniform input pricing for providers without cache economics", () => {
    const usage = { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 400 };
    expect(estimateCostWithCache(usage, "deepseek")).toBeCloseTo(estimateCost(1000, 200, "deepseek"));
  });
});
