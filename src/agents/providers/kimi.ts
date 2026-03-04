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
 * Base URLs:
 * - China: https://api.moonshot.cn/v1
 * - International: https://api.moonshot.ai/v1
 * - Coding: https://api.kimi.com/coding/v1
 *
 * @see https://platform.moonshot.ai/docs/api/chat
 */
export class KimiProvider extends OpenAIProvider {
  override readonly capabilities: ProviderCapabilities = {
    maxTokens: 8192,
    streaming: false,
    structuredStreaming: false,
    toolCalling: true,
    vision: true,
    systemPrompt: true,
  };

  constructor(
    apiKey: string,
    model = "kimi-for-coding",
    baseUrl = "https://api.kimi.com/coding/v1",
  ) {
    super(apiKey, model, baseUrl, "Kimi (Moonshot)");
  }
}
