import type {
  ConversationMessage,
  ProviderResponse,
  ToolCall,
  ProviderCapabilities,
} from "./provider.interface.js";
import { OpenAIProvider, OPENAI_STOP_REASON_MAP, stripReasoningBlocks } from "./openai.js";
import type { OpenAIMessage, OpenAIResponse } from "./openai.js";
import { getLogger } from "../../utils/logger.js";

/**
 * DeepSeek response extends OpenAI format with reasoning and cache fields.
 * - reasoning_content: Chain-of-thought from deepseek-reasoner models
 * - prompt_cache_hit/miss_tokens: Context caching statistics
 * - completion_tokens_details.reasoning_tokens: Reasoning token count
 */
interface DeepSeekResponse {
  choices: Array<{
    message: {
      content: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
        [key: string]: unknown;
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

/**
 * DeepSeek provider.
 *
 * Handles DeepSeek-specific API features:
 * - reasoning_content extraction from deepseek-reasoner models (R1 CoT)
 * - Prompt cache hit/miss token statistics
 * - Strips reasoning blocks from outgoing messages (DeepSeek requires
 *   reasoning_content NOT be fed back in subsequent requests)
 *
 * @see https://api-docs.deepseek.com/api/create-chat-completion
 */
export class DeepSeekProvider extends OpenAIProvider {
  override readonly capabilities: ProviderCapabilities = {
    maxTokens: 8192,
    streaming: true,
    structuredStreaming: false,
    toolCalling: true,
    vision: false,
    systemPrompt: true,
    contextWindow: 128_000,
    thinkingSupported: true,
    specialFeatures: ["reasoning", "context_caching"],
  };

  constructor(
    apiKey: string,
    model = "deepseek-chat",
    baseUrl = "https://api.deepseek.com/v1",
  ) {
    super(apiKey, model, baseUrl, "DeepSeek");
  }

  protected override parseResponse(data: OpenAIResponse): ProviderResponse {
    const dsData = data as unknown as DeepSeekResponse;
    const choice = dsData.choices[0];
    if (!choice) throw new Error("DeepSeek returned empty choices");

    const message = choice.message;
    const reasoning = message.reasoning_content;
    const content = message.content ?? "";

    // Prepend reasoning content when present (R1 chain-of-thought)
    const text = reasoning
      ? `<reasoning>\n${reasoning}\n</reasoning>\n\n${content}`
      : content;

    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => {
      let input: import("../../types/index.js").JsonObject;
      try {
        input = JSON.parse(tc.function.arguments) as import("../../types/index.js").JsonObject;
      } catch {
        input = { _rawArguments: tc.function.arguments };
      }
      return { id: tc.id, name: tc.function.name, input };
    });

    const stopReason = OPENAI_STOP_REASON_MAP[choice.finish_reason] ?? "end_turn";

    // Log cache hit stats when available
    const usage = dsData.usage;
    if (usage?.prompt_cache_hit_tokens) {
      const logger = getLogger();
      logger.debug("DeepSeek cache stats", {
        cacheHit: usage.prompt_cache_hit_tokens,
        cacheMiss: usage.prompt_cache_miss_tokens ?? 0,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
      });
    }

    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
        cacheReadInputTokens: usage?.prompt_cache_hit_tokens,
      },
    };
  }

  protected override buildMessages(systemPrompt: string, messages: ConversationMessage[]): OpenAIMessage[] {
    const result = super.buildMessages(systemPrompt, messages);

    // DeepSeek requires reasoning_content NOT be fed back in subsequent requests.
    stripReasoningBlocks(result);

    return result;
  }
}
