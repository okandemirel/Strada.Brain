import type {
  ConversationMessage,
  ProviderResponse,
  ToolCall,
  ProviderCapabilities,
} from "./provider.interface.js";
import { OpenAIProvider } from "./openai.js";
import type { OpenAIMessage, OpenAIResponse } from "./openai.js";
import { stripReasoningBlocks, OPENAI_STOP_REASON_MAP } from "./openai.js";

/**
 * MiniMax extends the OpenAI response with reasoning_details.
 */
interface MiniMaxResponse {
  choices: Array<{
    message: {
      content: string | null;
      reasoning_details?: string | null;
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
  };
}

/**
 * MiniMax provider.
 *
 * Handles MiniMax-specific API features:
 * - reasoning_details extraction (thinking/reasoning content from M2.5)
 * - Temperature must be in (0.0, 1.0] range
 * - Unsupported params: presence_penalty, frequency_penalty, logit_bias, n>1
 *
 * @see https://platform.minimax.io/docs/api-reference/text-openai-api
 */
export class MiniMaxProvider extends OpenAIProvider {
  override readonly capabilities: ProviderCapabilities = {
    maxTokens: 4096,
    streaming: true,
    structuredStreaming: false,
    toolCalling: true,
    vision: false,
    systemPrompt: true,
  };

  constructor(
    apiKey: string,
    model = "MiniMax-M2.5",
    baseUrl = "https://api.minimax.io/v1",
  ) {
    super(apiKey, model, baseUrl, "MiniMax");
  }

  protected override buildMessages(systemPrompt: string, messages: ConversationMessage[]): OpenAIMessage[] {
    const result = super.buildMessages(systemPrompt, messages);

    // MiniMax M2.5 reasoning_details must not be sent back in subsequent requests.
    stripReasoningBlocks(result);

    return result;
  }

  protected override parseResponse(data: OpenAIResponse): ProviderResponse {
    const mmData = data as unknown as MiniMaxResponse;
    const choice = mmData.choices[0];
    if (!choice) throw new Error("MiniMax returned empty choices");

    const message = choice.message;
    const reasoning = message.reasoning_details;
    const content = message.content ?? "";

    // Prepend reasoning details when present (M2.5 thinking mode)
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

    const usage = mmData.usage;
    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
      },
    };
  }
}
