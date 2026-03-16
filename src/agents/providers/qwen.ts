import type {
  ProviderCapabilities,
} from "./provider.interface.js";
import { OpenAIProvider } from "./openai.js";
import type { OpenAIMessage } from "./openai.js";

/**
 * Qwen (Alibaba DashScope) provider.
 *
 * Handles DashScope-specific API features:
 * - enable_search: Allows the model to perform web searches before answering
 *   (supported by qwen-max and qwen3-max models)
 * - result_format: Ensures OpenAI-compatible message response format
 *
 * Base URLs (API keys are NOT interchangeable across regions):
 * - International (Singapore): https://dashscope-intl.aliyuncs.com/compatible-mode/v1
 * - US (Virginia): https://dashscope-us.aliyuncs.com/compatible-mode/v1
 * - China (Beijing): https://dashscope.aliyuncs.com/compatible-mode/v1
 *
 * @see https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope
 */
export class QwenProvider extends OpenAIProvider {
  override readonly capabilities: ProviderCapabilities = {
    maxTokens: 8192,
    streaming: true,
    structuredStreaming: false,
    toolCalling: true,
    vision: false,
    systemPrompt: true,
    contextWindow: 1_000_000,
    thinkingSupported: false,
    specialFeatures: ["web_search", "multilingual"],
  };

  constructor(
    apiKey: string,
    model = "qwen-max",
    baseUrl = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  ) {
    super(apiKey, model, baseUrl, "Qwen (Alibaba)");
  }

  protected override buildRequestBody(
    messages: OpenAIMessage[],
    tools: unknown,
  ): Record<string, unknown> {
    const body = super.buildRequestBody(messages, tools);
    // DashScope requires result_format for OpenAI-compatible responses
    body["result_format"] = "message";
    // Web search integration — disabled by default, supported by qwen-max models
    body["enable_search"] = false;
    return body;
  }
}
