import type {
  ProviderResponse,
  ProviderCapabilities,
} from "./provider.interface.js";
import { OpenAIProvider } from "./openai.js";
import type { OpenAIResponse } from "./openai.js";
import { getLogger } from "../../utils/logger.js";

/**
 * Groq extends the OpenAI response with x_groq metadata.
 * @see https://console.groq.com/docs/api-reference
 */
interface GroqResponse extends OpenAIResponse {
  x_groq?: {
    id?: string;
  };
}

/**
 * Groq provider.
 *
 * Handles Groq-specific API features:
 * - x_groq response metadata logging (request ID for tracing)
 * - Optimized for Groq's LPU inference engine
 *
 * @see https://console.groq.com/docs/api-reference
 */
export class GroqProvider extends OpenAIProvider {
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
    model = "openai/gpt-oss-120b",
    baseUrl = "https://api.groq.com/openai/v1",
  ) {
    super(apiKey, model, baseUrl, "Groq");
  }

  protected override parseResponse(data: OpenAIResponse): ProviderResponse {
    const groqData = data as unknown as GroqResponse;

    // Log Groq request ID for tracing/debugging
    if (groqData.x_groq?.id) {
      const logger = getLogger();
      logger.debug("Groq request", { requestId: groqData.x_groq.id });
    }

    return super.parseResponse(data);
  }
}
