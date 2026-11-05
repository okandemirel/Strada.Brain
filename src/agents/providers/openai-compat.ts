import type { ToolDefinition } from "./provider.interface.js";

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

/**
 * The share of `prompt_tokens` an OpenAI-compatible endpoint served from its
 * prefix cache, or 0 when it reports no hit.
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
 */
export function cachedPromptTokens(usage: OpenAICompatCacheUsage | undefined): number {
  const openai = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return openai > 0 ? openai : (usage?.prompt_cache_hit_tokens ?? 0);
}
