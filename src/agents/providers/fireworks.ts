import type {
  ProviderResponse,
  ProviderCapabilities,
} from "./provider.interface.js";
import { OpenAIProvider } from "./openai.js";
import type { OpenAIResponse } from "./openai.js";

/**
 * Fireworks extends the standard OpenAI response with total_tokens.
 */
interface FireworksResponse extends OpenAIResponse {
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens?: number;
  };
}

/**
 * Fireworks AI provider.
 *
 * Handles Fireworks-specific API features:
 * - Uses API-provided total_tokens when available
 * - Model IDs use accounts/fireworks/models/... path format
 * - Optimized for fast inference on open-source models
 *
 * @see https://docs.fireworks.ai/tools-sdks/openai-compatibility
 */
export class FireworksProvider extends OpenAIProvider {
  override readonly capabilities: ProviderCapabilities = {
    maxTokens: 4096,
    streaming: false,
    structuredStreaming: false,
    toolCalling: true,
    vision: true,
    systemPrompt: true,
  };

  constructor(
    apiKey: string,
    model = "accounts/fireworks/models/llama4-maverick-instruct-basic",
    baseUrl = "https://api.fireworks.ai/inference/v1",
  ) {
    super(apiKey, model, baseUrl, "Fireworks AI");
  }

  protected override parseResponse(data: OpenAIResponse): ProviderResponse {
    const response = super.parseResponse(data);

    // Use API-provided total_tokens when available instead of calculated sum
    const rawUsage = (data as unknown as FireworksResponse).usage;
    if (rawUsage?.total_tokens !== undefined) {
      return {
        ...response,
        usage: {
          ...response.usage,
          totalTokens: rawUsage.total_tokens,
        },
      };
    }

    return response;
  }
}
