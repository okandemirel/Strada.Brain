import type { ProviderCapabilities } from "./provider.interface.js";
import { OpenAIProvider } from "./openai.js";

/**
 * OpenCode (Zen/Go) provider.
 *
 * OpenCode Zen/Go provides curated coding models through an OpenAI-compatible API.
 * A single API key grants access to all Zen/Go models regardless of subscription tier.
 *
 * Base URL: https://opencode.ai/zen/v1
 *
 * Supported models include (Zen):
 * - opencode/qwen-3-coder-480b (default)
 * - opencode/gpt-5.5
 * - opencode/claude-sonnet-4
 * - opencode/kimi-k2
 * - opencode/deepseek-v4-pro
 * - opencode/gemini-3-flash
 *
 * Supported models include (Go):
 * - opencode/glm-5.1
 * - opencode/glm-5
 * - opencode/kimi-k2.5
 * - opencode/kimi-k2.6
 * - opencode/mimo-v2-pro
 * - opencode/qwen-3.5-plus
 * - opencode/qwen-3.6-plus
 * - opencode/minimax-m2.5
 * - opencode/minimax-m2.7
 * - opencode/deepseek-v4-pro
 * - opencode/deepseek-v4-flash
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
    specialFeatures: ["coding", "function_calling", "json_mode"],
  };

  constructor(
    apiKey: string,
    model = "opencode/qwen-3-coder-480b",
    baseUrl = "https://opencode.ai/zen/v1",
  ) {
    super(apiKey, model, baseUrl, "OpenCode (Zen/Go)");
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
