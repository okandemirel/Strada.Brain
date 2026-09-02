import { describe, it, expect, vi } from "vitest";

const warnSpy = vi.fn();
vi.mock("../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({ info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() }),
}));

import {
  estimateCost,
  estimateCostWithCache,
  getProviderCosts,
  getUnpricedProvidersSeen,
  resolveCostRates,
  DEFAULT_COST,
  PROVIDER_COSTS,
} from "./cost-model.js";
import { PROVIDER_PRESETS } from "../agents/providers/provider-registry.js";

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

describe("every routable provider is priced, and an unpriced one is loud (audited 2026-09-02)", () => {
  // Eight registry providers (qwen, minimax, together, fireworks, opencode×3,
  // openrouter) silently fell to DEFAULT_COST — a 3M-token OpenCode wave on a
  // "-free" model recorded ~$6 that was never billed.
  it("has a table entry for every PROVIDER_PRESETS name plus claude", () => {
    const unpriced = [...Object.keys(PROVIDER_PRESETS), "claude"].filter((name) => !(name in PROVIDER_COSTS));
    expect(unpriced).toEqual([]);
  });

  it("prices a model whose id declares itself free at $0, whatever the provider table says", () => {
    const usage = { inputTokens: 3_000_000, outputTokens: 10_000, model: "nemotron-3.5-lightning-free" };
    expect(estimateCostWithCache(usage, "opencode2")).toBe(0);
    expect(resolveCostRates("opencode2", "nemotron-3.5-lightning-free").source).toBe("free-model");
    expect(resolveCostRates("openrouter", "meta-llama/llama-3.3-70b-instruct:free").source).toBe("free-model");
    // a non-free model on the same account is billed from the table
    expect(estimateCostWithCache({ inputTokens: 1_000_000, outputTokens: 0, model: "qwen3.6-plus" }, "opencode2")).toBeCloseTo(0.6);
  });

  it("names the fallback: an unknown provider's rates carry source=fallback, warn once, and are listed", () => {
    warnSpy.mockClear();
    const first = resolveCostRates("brand-new-provider", "some-model");
    expect(first.source).toBe("fallback");
    expect(first).toMatchObject(DEFAULT_COST);
    resolveCostRates("brand-new-provider");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({ provider: "brand-new-provider" });
    expect(getUnpricedProvidersSeen()).toContain("brand-new-provider");
    expect(resolveCostRates("claude").source).toBe("table");
  });
});
