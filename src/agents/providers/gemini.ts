import type {
  ConversationMessage,
  ProviderResponse,
  ToolCall,
  ProviderCapabilities,
} from "./provider.interface.js";
import type { MessageContent } from "./provider-core.interface.js";
import { OpenAIProvider, OPENAI_STOP_REASON_MAP } from "./openai.js";
import type { OpenAIMessage, OpenAIResponse } from "./openai.js";

/**
 * Google Gemini provider.
 * Extends OpenAI-compatible provider with thought_signature handling.
 *
 * Gemini 2.5+/3.x returns `extra_content` on tool_call objects containing
 * `google.thought_signature`. This signature MUST be echoed back in
 * subsequent requests or the API returns HTTP 400.
 *
 * Streaming is disabled because the SSE streaming path cannot capture
 * extra_content/thought_signature from delta chunks, which would cause
 * HTTP 400 on the next turn when the signature is missing.
 */
export class GeminiProvider extends OpenAIProvider {
  override readonly capabilities: ProviderCapabilities = {
    maxTokens: 4096,
    streaming: false,
    structuredStreaming: false,
    toolCalling: true,
    vision: false,
    systemPrompt: true,
  };

  constructor(
    apiKey: string,
    model = "gemini-3-flash-preview",
    baseUrl = "https://generativelanguage.googleapis.com/v1beta/openai",
  ) {
    super(apiKey, model, baseUrl, "Google Gemini");
  }

  protected override parseResponse(data: OpenAIResponse): ProviderResponse {
    const choice = data.choices[0];
    if (!choice) {
      throw new Error("Google Gemini returned empty choices");
    }

    const message = choice.message;
    const text = message.content ?? "";
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => {
      let input: import("../../types/index.js").JsonObject;
      try {
        input = JSON.parse(tc.function.arguments) as import("../../types/index.js").JsonObject;
      } catch {
        input = { _rawArguments: tc.function.arguments };
      }

      // Capture extra_content (contains google.thought_signature) as providerMetadata
      const { id: _toolCallId, type: _toolCallType, function: _toolCallFunction, ...rest } = tc;
      const providerMetadata = Object.keys(rest).length > 0 ? rest : undefined;

      return providerMetadata
        ? { id: tc.id, name: tc.function.name, input, providerMetadata }
        : { id: tc.id, name: tc.function.name, input };
    });

    const stopReason = OPENAI_STOP_REASON_MAP[choice.finish_reason] ?? "end_turn";

    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0),
      },
    };
  }

  protected override buildMessages(systemPrompt: string, messages: ConversationMessage[]): OpenAIMessage[] {
    const result: OpenAIMessage[] = [{ role: "system", content: systemPrompt }];

    for (const msg of messages) {
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          result.push({ role: "user", content: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content as MessageContent[]) {
            if (block.type === "text") {
              result.push({ role: "user", content: block.text });
            } else if (block.type === "tool_result") {
              result.push({
                role: "tool",
                tool_call_id: block.tool_use_id,
                content: block.content,
              });
            }
          }
        }
      } else if (msg.role === "assistant") {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const assistantMsg: OpenAIMessage = {
            role: "assistant",
            content: msg.content || null,
            tool_calls: msg.tool_calls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input),
              },
              // Echo back extra_content (thought_signature) from providerMetadata
              ...(tc.providerMetadata ?? {}),
            })),
          };
          result.push(assistantMsg);
        } else {
          result.push({ role: "assistant", content: msg.content });
        }
      }
    }

    return result;
  }
}
