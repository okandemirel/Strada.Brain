import type { ProviderCapabilities } from "./provider.interface.js";
import { OpenAIProvider } from "./openai.js";

/**
 * OpenCode hosted-platform base URLs (both OpenAI-compatible). The Go API lives
 * UNDER the zen path — opencode.ai/zen/go/v1 — NOT opencode.ai/go (a marketing
 * page; opencode.ai/go/v1 returns an HTML 404). Verified live via GET /models.
 *
 * Mirrored in the web portal at web-portal/src/types/setup-constants.ts
 * (OPENCODE_PLATFORM_BASE_URLS) — separate package, no shared import, keep in sync.
 */
export const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

/**
 * OpenCode (Zen/Go) provider.
 *
 * OpenCode Zen/Go provides curated coding models through an OpenAI-compatible API.
 * A single API key grants access to all Zen/Go models regardless of subscription tier.
 *
 * Base URLs: Zen = https://opencode.ai/zen/v1 (default), Go = https://opencode.ai/zen/go/v1.
 *
 * IMPORTANT — model id format: the API expects BARE ids (NO "opencode/" namespace).
 * The constructor strips a leading "opencode/" defensively because presets / saved
 * preferences / the model catalog historically used the namespaced form, which the API
 * now rejects ("ModelError: Model opencode/... is not supported"). Verified live via
 * GET /models. Model ids that are no longer offered must not be reintroduced.
 *
 * Current model ids (bare), from GET /models:
 * - Coding/general: qwen3.6-plus (default), qwen3.5-plus, deepseek-v4-flash, glm-5.1, glm-5
 * - OpenAI: gpt-5.5, gpt-5.5-pro, gpt-5.4, gpt-5.4-mini, gpt-5.2-codex, ...
 * - Anthropic: claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5, ...
 * - Others: gemini-3.5-flash, kimi-k2.6, kimi-k2.5, minimax-m2.7, minimax-m2.5
 *
 * @see https://opencode.ai/zen
 * @see https://opencode.ai/go
 */
export class OpencodeProvider extends OpenAIProvider {
  override readonly capabilities: ProviderCapabilities = {
    maxTokens: 8192,
    streaming: true,
    structuredStreaming: false,
    toolCalling: true,
    vision: true,
    systemPrompt: true,
    contextWindow: 128_000,
    thinkingSupported: false,
    // Measured 2026-08-21 against opencode.ai/zen/go with deepseek-v4-flash on
    // a goal-decomposition prompt: default effort spent 1595 reasoning chunks
    // before answering, "low" 876, "minimal" 497 — and minimal returned MORE
    // answer (1623 characters) than low (1285). The model always gets there;
    // the cost of thinking longer is latency, and latency is what a streaming
    // stall timeout measures. OPENCODE_REASONING_EFFORT overrides it for a
    // model or a workload that wants the deliberation.
    reasoningEffort:
      (process.env["OPENCODE_REASONING_EFFORT"] as ProviderCapabilities["reasoningEffort"]) ?? "low",
    specialFeatures: ["coding", "function_calling", "json_mode"],
  };

  constructor(
    apiKey: string,
    model = "qwen3.6-plus",
    baseUrl = OPENCODE_ZEN_BASE_URL,
  ) {
    super(apiKey, OpencodeProvider.toBareModelId(model), baseUrl, "OpenCode (Zen/Go)");
  }

  /**
   * OpenCode's API rejects namespaced model ids, so strip a leading "opencode/" — a
   * preset/preference/catalog value like "opencode/deepseek-v4-flash" becomes the bare
   * "deepseek-v4-flash" the API accepts. (Verified live via GET /models.)
   */
  private static toBareModelId(model: string): string {
    return model.startsWith("opencode/") ? model.slice("opencode/".length) : model;
  }

  /**
   * Build HTTP headers for OpenCode API requests.
   * Adds a User-Agent header identifying Strada.Brain.
   */
  protected override async buildHeaders(): Promise<Record<string, string>> {
    const headers = await super.buildHeaders();
    return {
      ...headers,
      "User-Agent": "Strada.Brain/1.0",
    };
  }

  // parseResponse is inherited from OpenAIProvider and works correctly
  // for OpenCode's OpenAI-compatible API. Override here if OpenCode adds
  // provider-specific response fields in the future.
}
