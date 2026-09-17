/**
 * Audit 03.2 / D21 (2026-09-13), plan 0-A.14: the run-local budget gate priced
 * every input token at the full rate while the ledger billed cache reads at a
 * tenth — one million cache-read tokens debited $3.00 from a run's headroom
 * against $0.30 recorded, and a run could stop on phantom cost.
 */
import { describe, it, expect } from "vitest";
import { toBudgetUsage } from "./v2-agent-runner.js";
import { estimateCostWithCache, resolveCostRates } from "../../budget/cost-model.js";

describe("toBudgetUsage prices the cached share of the prompt like the ledger does", () => {
  it("a million cache-read tokens cost a tenth of a million plain ones", () => {
    const rates = resolveCostRates("claude");
    expect(rates.input).toBeGreaterThan(0);
    const plain = toBudgetUsage({ inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 }, "claude", "claude-sonnet-5");
    const cached = toBudgetUsage(
      { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, cacheReadInputTokens: 1_000_000 },
      "claude",
      "claude-sonnet-5",
    );
    expect(plain.costUsd).toBeCloseTo(rates.input, 6);
    expect(cached.costUsd).toBeCloseTo(rates.input * 0.1, 6);
    // …exactly what the ledger records for the same usage.
    expect(cached.costUsd).toBeCloseTo(
      estimateCostWithCache({ inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 1_000_000, model: "claude-sonnet-5" }, "claude"),
      9,
    );
  });

  it("a free-tier model still prices at zero, and a plain prompt is unchanged (guard)", () => {
    expect(toBudgetUsage({ inputTokens: 5000, outputTokens: 100, totalTokens: 5100 }, "opencode", "some-model:free").costUsd).toBe(0);
    const rates = resolveCostRates("claude");
    const plain = toBudgetUsage({ inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 }, "claude", "claude-sonnet-5");
    expect(plain.costUsd).toBeCloseTo((1000 * rates.input + 1000 * rates.output) / 1_000_000, 9);
  });
});
