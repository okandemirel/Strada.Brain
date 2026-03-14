import type {
  ProviderCapabilities,
} from "./provider.interface.js";
import { OpenAIProvider } from "./openai.js";
import type { OpenAIMessage } from "./openai.js";

/**
 * Mistral provider.
 *
 * Handles Mistral-specific API features:
 * - safe_prompt: Injects safety system prompt for content moderation (default: false)
 * - random_seed: Enables deterministic outputs for testing/evals
 *
 * @see https://docs.mistral.ai/api/endpoint/chat
 */
export class MistralProvider extends OpenAIProvider {
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
    model = "mistral-large-latest",
    baseUrl = "https://api.mistral.ai/v1",
  ) {
    super(apiKey, model, baseUrl, "Mistral");
  }

  protected override buildRequestBody(
    messages: OpenAIMessage[],
    tools: unknown,
  ): Record<string, unknown> {
    const body = super.buildRequestBody(messages, tools);
    // Mistral's safe_prompt prepends a safety system prompt for content moderation.
    // Default to false to preserve the user's system prompt unchanged.
    body["safe_prompt"] = false;
    return body;
  }
}
