/**
 * Cost Model for Strada Brain
 *
 * Provides per-provider token cost rates and cost estimation utilities.
 * Used by the UnifiedBudgetManager and other subsystems that need to
 * translate token counts into USD spend.
 */

import { getLoggerSafe } from "../utils/logger.js";

/** Approximate cost per 1M tokens for each provider (USD). */
export const PROVIDER_COSTS: Record<string, { input: number; output: number }> = {
  claude: { input: 3.0, output: 15.0 },
  openai: { input: 2.5, output: 10.0 },
  deepseek: { input: 0.14, output: 0.28 },
  groq: { input: 0.05, output: 0.08 },
  mistral: { input: 0.25, output: 0.25 },
  ollama: { input: 0, output: 0 },
  gemini: { input: 0.075, output: 0.3 },
  kimi: { input: 0.7, output: 1.4 },
  // Eight routable providers (provider-registry PROVIDER_PRESETS) had no entry
  // and fell to DEFAULT_COST ($2/$10) with no log and no flag — the live
  // daemon.db carried $957 of the $2,768 recorded spend priced that way,
  // ~$598 of it on models literally named "-free" (audited 2026-09-02).
  // Rates below are each provider's registry defaultModel priced from
  // src/config/presets.ts (pricing verified March 2026).
  qwen: { input: 0.8, output: 2.0 }, // qwen-max
  minimax: { input: 0.3, output: 1.2 }, // MiniMax-M2.7
  together: { input: 0.27, output: 0.85 }, // Llama 4 Maverick
  fireworks: { input: 0.22, output: 0.88 }, // llama4-maverick-instruct-basic
  opencode: { input: 0.6, output: 3.0 }, // qwen3.6-plus (Zen default)
  opencode2: { input: 0.6, output: 3.0 },
  opencode3: { input: 0.6, output: 3.0 },
  openrouter: { input: 1.75, output: 14.0 }, // openai/gpt-5.2
};

/** Fallback cost rates for unknown providers. */
export const DEFAULT_COST = { input: 2.0, output: 10.0 };

/** Where a cost figure's rate came from — so a fallback-priced dollar is never mistaken for a measured one. */
export type CostRateSource = "table" | "free-model" | "fallback";

export interface ResolvedCostRates {
  readonly input: number;
  readonly output: number;
  readonly source: CostRateSource;
}

/** Models whose id declares them free (OpenCode Zen "-free" tier, OpenRouter ":free" variants). */
const FREE_MODEL_ID = /(-|:)free$/i;

/** Providers already warned about — one warning per unpriced name per process. */
const unpricedProvidersSeen = new Set<string>();

/** Provider names that hit the fallback rate since process start (for reporting). */
export function getUnpricedProvidersSeen(): readonly string[] {
  return [...unpricedProvidersSeen];
}

/**
 * Resolve the per-1M rates for a (provider, model) pair and SAY where they came
 * from. A model whose id ends in "-free"/":free" is $0 regardless of provider.
 * An unknown provider gets DEFAULT_COST, but loudly: one warn per name, and the
 * name is retained for {@link getUnpricedProvidersSeen}. The silent `?? DEFAULT_COST`
 * this replaces was the entire signal that a price was unknown (audited 2026-09-02).
 */
export function resolveCostRates(provider: string, model?: string): ResolvedCostRates {
  if (model && FREE_MODEL_ID.test(model)) {
    return { input: 0, output: 0, source: "free-model" };
  }
  const table = PROVIDER_COSTS[provider];
  if (table) {
    return { ...table, source: "table" };
  }
  if (!unpricedProvidersSeen.has(provider)) {
    unpricedProvidersSeen.add(provider);
    getLoggerSafe().warn("Unpriced provider — spend is being estimated at the fallback rate, not measured", {
      provider,
      model: model ?? null,
      fallbackInputPer1M: DEFAULT_COST.input,
      fallbackOutputPer1M: DEFAULT_COST.output,
    });
  }
  return { ...DEFAULT_COST, source: "fallback" };
}

/**
 * Zero out a provider's metered rates for FLAT-FEE (subscription) auth.
 *
 * Billing a ChatGPT subscription at API-key rates fabricated dollars: every
 * debit site charged phantom spend, `isGlobalExceeded()` measured it, and the
 * daemon's daily budget wall went quiet on money nobody paid. Called once at
 * bootstrap when the auth mode says the account is flat-fee.
 */
export function markProviderFlatFee(provider: string): void {
  PROVIDER_COSTS[provider] = { input: 0, output: 0 };
}

/**
 * Estimate cost in USD for a given token usage.
 *
 * @param inputTokens  Number of input (prompt) tokens consumed.
 * @param outputTokens Number of output (completion) tokens consumed.
 * @param provider     Provider name (e.g. "claude", "openai").
 * @param model        Concrete model id when known — a "-free" model prices at $0.
 * @returns Estimated cost in USD.
 */
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  provider: string,
  model?: string,
): number {
  const costs = resolveCostRates(provider, model);
  return (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
}

/** Usage shape carrying the cached share of the prompt (subset of inputTokens — see TokenUsage invariants). */
export interface CacheableTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  /** Concrete model id when routing knows it — free-tier ids ("-free") price at $0. */
  readonly model?: string;
}

/**
 * Cache-rate multipliers applied to the INPUT rate. Measured economics:
 * Anthropic bills a cache WRITE at ~1.25x and a cache READ at ~0.1x of input;
 * OpenAI bills cached prompt tokens at ~0.5x (no write premium). Providers not
 * listed bill all input uniformly (write/read multiplier 1) — with them, this
 * function degrades to estimateCost split across the token buckets.
 */
const CACHE_RATE_MULTIPLIERS: Record<string, { write: number; read: number }> = {
  claude: { write: 1.25, read: 0.1 },
  openai: { write: 1.0, read: 0.5 },
};

/**
 * Cache-aware cost estimate. TokenUsage's invariant is
 * `cacheCreation + cacheRead <= inputTokens` (the cached share is INCLUDED in
 * inputTokens), so the uncached remainder is what gets the plain input rate —
 * otherwise cache-heavy turns are billed twice (measured 2026-08-23: a
 * cache-heavy Claude session overstated cost ~4x under flat pricing).
 */
export function estimateCostWithCache(usage: CacheableTokenUsage, provider: string): number {
  const rates = resolveCostRates(provider, usage.model);
  const mult = CACHE_RATE_MULTIPLIERS[provider] ?? { write: 1, read: 1 };
  const cacheWrite = Math.max(0, usage.cacheCreationInputTokens ?? 0);
  const cacheRead = Math.max(0, usage.cacheReadInputTokens ?? 0);
  const plainInput = Math.max(0, usage.inputTokens - cacheWrite - cacheRead);
  return (
    plainInput * rates.input
    + cacheWrite * rates.input * mult.write
    + cacheRead * rates.input * mult.read
    + usage.outputTokens * rates.output
  ) / 1_000_000;
}

/**
 * Return the cost rates for a provider (for display / reporting).
 *
 * @param provider Provider name.
 * @returns Object with `input` and `output` cost per 1M tokens (USD).
 */
export function getProviderCosts(provider: string): { input: number; output: number } {
  const { input, output } = resolveCostRates(provider);
  return { input, output };
}
