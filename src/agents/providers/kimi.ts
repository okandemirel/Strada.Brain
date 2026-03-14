import type {
  ProviderCapabilities,
} from "./provider.interface.js";
import { OpenAIProvider } from "./openai.js";

/**
 * Kimi (Moonshot) provider.
 *
 * Supports Kimi K2/K2.5 models with:
 * - 256K context window
 * - Multimodal inputs (K2.5+)
 * - OpenAI-compatible function calling
 *
 * The coding endpoint (api.kimi.com/coding/v1) enforces User-Agent
 * whitelisting — only known coding agents are allowed. We send
 * `User-Agent: claude-code/0.1.0` to authenticate as a coding agent.
 *
 * Base URLs:
 * - China: https://api.moonshot.cn/v1
 * - International: https://api.moonshot.ai/v1
 * - Coding: https://api.kimi.com/coding/v1
 *
 * @see https://www.kimi.com/code/docs/en/more/third-party-agents.html
 */
export class KimiProvider extends OpenAIProvider {
  override readonly capabilities: ProviderCapabilities = {
    maxTokens: 8192,
    streaming: true,
    structuredStreaming: false,
    toolCalling: true,
    vision: false,
    systemPrompt: true,
  };

  constructor(
    apiKey: string,
    model = "kimi-for-coding",
    baseUrl = "https://api.kimi.com/coding/v1",
  ) {
    super(apiKey, model, baseUrl, "Kimi (Moonshot)");
  }

  protected override buildHeaders(): Record<string, string> {
    return {
      ...super.buildHeaders(),
      "User-Agent": "claude-code/0.1.0",
    };
  }
}
