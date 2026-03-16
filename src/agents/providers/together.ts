import type {
  ProviderResponse,
  ProviderCapabilities,
} from "./provider.interface.js";
import { OpenAIProvider } from "./openai.js";
import type { OpenAIResponse } from "./openai.js";

/**
 * Together AI extends the standard OpenAI response with total_tokens.
 */
interface TogetherResponse extends OpenAIResponse {
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens?: number;
  };
}

/**
 * Together AI provider.
 *
 * Handles Together-specific API features:
 * - Uses API-provided total_tokens when available (avoids rounding differences)
 * - Supports 200+ models via unified API (text, image, video, code, audio)
 * - Model IDs use org/model format (e.g., meta-llama/Llama-4-Maverick-...)
 *
 * @see https://docs.together.ai/reference/chat-completions-1
 */
export class TogetherProvider extends OpenAIProvider {
  override readonly capabilities: ProviderCapabilities = {
    maxTokens: 4096,
    streaming: true,
    structuredStreaming: false,
    toolCalling: true,
    vision: false,
    systemPrompt: true,
    contextWindow: 1_000_000,
    thinkingSupported: false,
    specialFeatures: ["open_models"],
  };

  constructor(
    apiKey: string,
    model = "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
    baseUrl = "https://api.together.xyz/v1",
  ) {
    super(apiKey, model, baseUrl, "Together AI");
  }

  protected override parseResponse(data: OpenAIResponse): ProviderResponse {
    const response = super.parseResponse(data);

    // Use API-provided total_tokens when available instead of calculated sum
    const rawUsage = (data as unknown as TogetherResponse).usage;
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
