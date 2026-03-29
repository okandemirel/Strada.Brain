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

/**
 * Return the cost rates for a provider (for display / reporting).
 *
 * @param provider Provider name.
 * @returns Object with `input` and `output` cost per 1M tokens (USD).
 */
export function getProviderCosts(provider: string): { input: number; output: number } {
  return PROVIDER_COSTS[provider] ?? DEFAULT_COST;
}
