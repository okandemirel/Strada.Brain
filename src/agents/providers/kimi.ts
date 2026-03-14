import type {
  ConversationMessage,
  ProviderResponse,
  ToolCall,
  ProviderCapabilities,
} from "./provider.interface.js";
import { OpenAIProvider, OPENAI_STOP_REASON_MAP } from "./openai.js";
import type { OpenAIMessage, OpenAIResponse } from "./openai.js";

/**
 * Kimi response extends OpenAI format with reasoning_content.
 * K2.5 thinking mode returns reasoning alongside content and tool calls.
 */
interface KimiResponse {
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
  };
}

/**
 * Kimi (Moonshot) provider.
 *
 * Handles Kimi-specific API features:
 * - User-Agent whitelisting: coding endpoint only allows known agents
 * - reasoning_content: K2.5 thinking mode returns reasoning that MUST be
 *   echoed back in assistant tool call messages or API returns 400
 * - Empty reasoning_content must be omitted entirely (not sent as "")
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

  protected override parseResponse(data: OpenAIResponse): ProviderResponse {
    const kimiData = data as unknown as KimiResponse;
    const choice = kimiData.choices[0];
    if (!choice) throw new Error("Kimi returned empty choices");

    const message = choice.message;
    const reasoning = message.reasoning_content;
    const content = message.content ?? "";

    // reasoning_content is a turn-level concept — attach only to the first tool call
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc, idx) => {
      let input: import("../../types/index.js").JsonObject;
      try {
        input = JSON.parse(tc.function.arguments) as import("../../types/index.js").JsonObject;
      } catch {
        input = { _rawArguments: tc.function.arguments };
      }
      // Store reasoning_content only on first tool call (buildMessages reads it back)
      const providerMetadata = idx === 0 && reasoning ? { reasoning_content: reasoning } : undefined;
      return providerMetadata
        ? { id: tc.id, name: tc.function.name, input, providerMetadata }
        : { id: tc.id, name: tc.function.name, input };
    });

    const stopReason = OPENAI_STOP_REASON_MAP[choice.finish_reason] ?? "end_turn";

    const usage = kimiData.usage;
    return {
      text: content,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
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
          for (const block of msg.content as import("./provider-core.interface.js").MessageContent[]) {
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
          // Kimi K2.5 requires reasoning_content on assistant tool call messages
          // when thinking mode is active. Omit if empty (Kimi rejects empty string).
          const reasoning = msg.tool_calls
            .find(tc => tc.providerMetadata?.reasoning_content)
            ?.providerMetadata?.reasoning_content as string | undefined;
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
            })),
          };
          if (reasoning) {
            (assistantMsg as unknown as Record<string, unknown>)["reasoning_content"] = reasoning;
          }
          result.push(assistantMsg);
        } else {
          result.push({ role: "assistant", content: msg.content });
        }
      }
    }

    return result;
  }
}
