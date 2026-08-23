/**
 * Cost Model for Strada Brain
 *
 * Provides per-provider token cost rates and cost estimation utilities.
 * Used by the UnifiedBudgetManager and other subsystems that need to
 * translate token counts into USD spend.
 */

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
};

/** Fallback cost rates for unknown providers. */
export const DEFAULT_COST = { input: 2.0, output: 10.0 };

/**
 * Estimate cost in USD for a given token usage.
 *
 * @param inputTokens  Number of input (prompt) tokens consumed.
 * @param outputTokens Number of output (completion) tokens consumed.
 * @param provider     Provider name (e.g. "claude", "openai").
 * @returns Estimated cost in USD.
 */
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  provider: string
): number {
  const costs = PROVIDER_COSTS[provider] ?? DEFAULT_COST;
  return (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
}

/** Usage shape carrying the cached share of the prompt (subset of inputTokens — see TokenUsage invariants). */
export interface CacheableTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
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
  const rates = PROVIDER_COSTS[provider] ?? DEFAULT_COST;
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
  return PROVIDER_COSTS[provider] ?? DEFAULT_COST;
}
