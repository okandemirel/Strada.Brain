import type { ProviderCapabilities } from "./provider.interface.js";
import { OpenAIProvider } from "./openai.js";

/**
 * OpenRouter provider.
 *
 * OpenRouter is a unified, OpenAI-compatible gateway that routes requests to
 * hundreds of models from many upstream providers behind a single API key.
 *
 * Base URL: https://openrouter.ai/api/v1
 * Auth: OPENROUTER_API_KEY (Bearer token).
 *
 * OpenRouter recommends sending two optional ranking headers on every request:
 * - HTTP-Referer: identifies the calling app on openrouter.ai leaderboards.
 * - X-Title: human-readable app name shown alongside the referer.
 * These are optional but improve attribution, so Strada.Brain sets sane
 * defaults.
 *
 * Model ids are namespaced by upstream provider, e.g.:
 * - openai/gpt-5.2
 * - anthropic/claude-sonnet-4
 * - google/gemini-3-flash
 * - deepseek/deepseek-chat
 * - meta-llama/llama-4-maverick
 *
 * @see https://openrouter.ai/docs
 */
export class OpenRouterProvider extends OpenAIProvider {
  override readonly capabilities: ProviderCapabilities = {
    maxTokens: 8192,
    streaming: true,
    structuredStreaming: false,
    toolCalling: true,
    vision: true,
    systemPrompt: true,
    contextWindow: 128_000,
    thinkingSupported: false,
    specialFeatures: ["function_calling", "json_mode"],
  };

  constructor(
    apiKey: string,
    model = "openai/gpt-5.2",
    baseUrl = "https://openrouter.ai/api/v1",
  ) {
    super(apiKey, model, baseUrl, "OpenRouter");
  }

  /**
   * Build HTTP headers for OpenRouter API requests.
   * Adds the optional HTTP-Referer and X-Title ranking headers OpenRouter
   * recommends for app attribution.
   */
  protected override async buildHeaders(): Promise<Record<string, string>> {
    const headers = await super.buildHeaders();
    return {
      ...headers,
      "HTTP-Referer": "https://github.com/okandemirel/Strada.Brain",
      "X-Title": "Strada.Brain",
    };
  }

  // parseResponse is inherited from OpenAIProvider and works correctly for
  // OpenRouter's OpenAI-compatible API. Override here if OpenRouter adds
  // provider-specific response fields in the future.
}
