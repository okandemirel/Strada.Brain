import type {
  IAIProvider,
  ConversationMessage,
  ToolDefinition,
  ProviderResponse,
  ToolCall,
} from "./provider.interface.js";
import { getLogger } from "../../utils/logger.js";
import { convertToolDefinitions } from "./openai-compat.js";

/**
 * OpenAI-compatible provider.
 * Works with OpenAI API and any compatible endpoint (Azure, Together, etc.).
 */
export class OpenAIProvider implements IAIProvider {
  readonly name = "openai";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(
    apiKey: string,
    model = "gpt-4o",
    baseUrl = "https://api.openai.com/v1"
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async chat(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[]
  ): Promise<ProviderResponse> {
    const logger = getLogger();

    const openaiMessages = this.buildMessages(systemPrompt, messages);
    const openaiTools = convertToolDefinitions(tools);

    logger.debug("OpenAI API call", {
      model: this.model,
      messageCount: openaiMessages.length,
      toolCount: tools.length,
    });

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 4096,
      messages: openaiMessages,
    };
    if (openaiTools) {
      body["tools"] = openaiTools;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = (await response.text()).slice(0, 200);
      throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as OpenAIResponse;
    return this.parseResponse(data);
  }

  private buildMessages(
    systemPrompt: string,
    messages: ConversationMessage[]
  ): OpenAIMessage[] {
    const result: OpenAIMessage[] = [
      { role: "system", content: systemPrompt },
    ];

    for (const msg of messages) {
      if (msg.role === "user") {
        if (msg.toolResults && msg.toolResults.length > 0) {
          for (const tr of msg.toolResults) {
            result.push({
              role: "tool",
              tool_call_id: tr.toolCallId,
              content: tr.content,
            });
          }
        } else {
          result.push({ role: "user", content: msg.content });
        }
      } else if (msg.role === "assistant") {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const assistantMsg: OpenAIMessage = {
            role: "assistant",
            content: msg.content || null,
            tool_calls: msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input),
              },
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

  private parseResponse(data: OpenAIResponse): ProviderResponse {
    const choice = data.choices[0];
    if (!choice) {
      throw new Error("OpenAI returned empty choices");
    }

    const message = choice.message;
    const text = message.content ?? "";
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        input = { _rawArguments: tc.function.arguments };
      }
      return { id: tc.id, name: tc.function.name, input };
    });

    const stopReason =
      choice.finish_reason === "tool_calls"
        ? "tool_use"
        : choice.finish_reason === "length"
          ? "max_tokens"
          : "end_turn";

    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}

// --- OpenAI API types ---

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}
