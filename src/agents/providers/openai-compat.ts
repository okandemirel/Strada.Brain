import type { TokenUsage, ToolDefinition } from "./provider.interface.js";

/**
 * Convert tool definitions to the OpenAI-compatible function calling format.
 * Shared by OpenAI, Ollama, and other compatible providers.
 */
export function convertToolDefinitions(tools: ToolDefinition[]) {
  return tools.length > 0
    ? tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }))
    : undefined;
}

/** The usage fields an OpenAI-compatible endpoint may report its prompt-cache hit in. */
export interface OpenAICompatCacheUsage {
  readonly prompt_tokens_details?: { readonly cached_tokens?: number };
  readonly prompt_cache_hit_tokens?: number;
}

const OPENAI_CACHE_FIELD = "prompt_tokens_details.cached_tokens";
const DEEPSEEK_CACHE_FIELD = "prompt_cache_hit_tokens";

const tokenCount = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

/**
 * The share of `prompt_tokens` an OpenAI-compatible endpoint served from its
 * prefix cache, and the field it came in, ready to spread into a TokenUsage.
 * Empty when the usage block carried no cache field at all.
 *
 * OpenAI names it `prompt_tokens_details.cached_tokens`; DeepSeek's own API
 * names it `prompt_cache_hit_tokens`. A relay serving DeepSeek models behind
 * an OpenAI-compatible endpoint (OpenCode Go) may pass DeepSeek's field
 * through untranslated, and reading only OpenAI's left each such call's cache
 * share out of its log line, so scripts/eval/cache-hit-report.mjs could only
 * ever call those calls "not measured" (2026-11-05). Both fields are subsets
 * of `prompt_tokens`, so either fits `TokenUsage.cacheReadInputTokens`.
 * OpenAI's field is read first; DeepSeek's when OpenAI's is absent or zero,
 * which also covers a relay that fills `cached_tokens: 0` beside it.
 *
 * A field that came as 0 is kept as 0. Turning it into "no field" made a run
 * of misses and a provider that never reports its cache the same log line,
 * and the hit-rate report could only call both "not measured" (2026-11-05).
 */
export function promptCacheUsage(
  usage: OpenAICompatCacheUsage | undefined,
): Pick<TokenUsage, "cacheReadInputTokens" | "cacheReadField"> {
  const openai = tokenCount(usage?.prompt_tokens_details?.cached_tokens);
  const deepseek = tokenCount(usage?.prompt_cache_hit_tokens);
  const fields = [
    ...(openai === undefined ? [] : [OPENAI_CACHE_FIELD]),
    ...(deepseek === undefined ? [] : [DEEPSEEK_CACHE_FIELD]),
  ];
  if (fields.length === 0) return {};
  const cached = openai !== undefined && openai > 0 ? openai : (deepseek ?? openai ?? 0);
  return { cacheReadInputTokens: cached, cacheReadField: fields.join("+") };
}
