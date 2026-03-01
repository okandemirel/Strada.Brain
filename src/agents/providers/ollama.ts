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
 * Ollama provider for local LLM inference.
 * Talks to the Ollama REST API (OpenAI-compatible endpoint).
 */
export class OllamaProvider implements IAIProvider {
  readonly name = "ollama";
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(
    model = "llama3.1",
    baseUrl = "http://localhost:11434"
  ) {
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async chat(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[]
  ): Promise<ProviderResponse> {
    const logger = getLogger();

    const ollamaMessages = this.buildMessages(systemPrompt, messages);
    const ollamaTools = convertToolDefinitions(tools);

    logger.debug("Ollama API call", {
      model: this.model,
      messageCount: ollamaMessages.length,
      toolCount: tools.length,
    });

    const body: Record<string, unknown> = {
      model: this.model,
      messages: ollamaMessages,
      stream: false,
      options: { num_predict: 4096 },
    };
    if (ollamaTools) {
      body["tools"] = ollamaTools;
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = (await response.text()).slice(0, 200);
      throw new Error(`Ollama API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as OllamaResponse;
    return this.parseResponse(data);
  }

  private buildMessages(
    systemPrompt: string,
    messages: ConversationMessage[]
  ): OllamaMessage[] {
    const result: OllamaMessage[] = [
      { role: "system", content: systemPrompt },
    ];

    for (const msg of messages) {
      if (msg.role === "user") {
        if (msg.toolResults && msg.toolResults.length > 0) {
          for (const tr of msg.toolResults) {
            result.push({ role: "tool", content: tr.content });
          }
        } else {
          result.push({ role: "user", content: msg.content });
        }
      } else if (msg.role === "assistant") {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          result.push({
            role: "assistant",
            content: msg.content || "",
            tool_calls: msg.toolCalls.map((tc) => ({
              function: {
                name: tc.name,
                arguments: tc.input,
              },
            })),
          });
        } else {
          result.push({ role: "assistant", content: msg.content });
        }
      }
    }

    return result;
  }

  private parseResponse(data: OllamaResponse): ProviderResponse {
    const message = data.message;
    const text = message.content ?? "";
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc, i) => ({
      id: `ollama-tc-${i}`,
      name: tc.function.name,
      input: tc.function.arguments as Record<string, unknown>,
    }));

    const stopReason = toolCalls.length > 0 ? "tool_use" : "end_turn";

    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
    };
  }
}

// --- Ollama API types ---

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

interface OllamaResponse {
  message: {
    content: string;
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, unknown> };
    }>;
  };
  prompt_eval_count?: number;
  eval_count?: number;
}
