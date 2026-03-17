import type {
  ConversationMessage,
  ProviderResponse,
  ToolCall,
  ToolDefinition,
  StreamCallback,
  ProviderCapabilities,
} from "./provider.interface.js";
import type { AssistantMessage } from "./provider-core.interface.js";
import { OpenAIProvider, OPENAI_STOP_REASON_MAP, MAX_SSE_BUFFER_BYTES } from "./openai.js";
import type { OpenAIMessage, OpenAIResponse } from "./openai.js";
import { getLogger } from "../../utils/logger.js";
import { convertToolDefinitions } from "./openai-compat.js";

/** SSE chunk with extra_content support for thought_signature */
interface GeminiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
        [key: string]: unknown;
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Google Gemini provider.
 * Extends OpenAI-compatible provider with thought_signature handling.
 *
 * Gemini 2.5+/3.x returns `extra_content` on tool_call objects containing
 * `google.thought_signature`. This signature MUST be echoed back in
 * subsequent requests or the API returns HTTP 400.
 *
 * Streaming captures extra_content from SSE delta chunks to preserve
 * thought_signature for multi-turn conversations.
 */
export class GeminiProvider extends OpenAIProvider {
  override readonly capabilities: ProviderCapabilities = {
    maxTokens: 4096,
    streaming: true,
    structuredStreaming: false,
    toolCalling: true,
    vision: true,
    systemPrompt: true,
    contextWindow: 1_000_000,
    thinkingSupported: true,
    specialFeatures: ["grounding", "thinking_level", "code_execution"],
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

  /**
   * Override streaming to capture extra_content (thought_signature) from SSE deltas.
   * Without this, the signature is lost and the next API call returns HTTP 400.
   */
  override async chatStream(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    onChunk: StreamCallback,
  ): Promise<ProviderResponse> {
    const logger = getLogger();
    const openaiMessages = this.buildMessages(systemPrompt, messages);
    const openaiTools = convertToolDefinitions(tools);

    logger.debug(`${this.name} streaming API call`, {
      model: this.model,
      messageCount: openaiMessages.length,
    });

    const body = this.buildRequestBody(openaiMessages, openaiTools);
    body["stream"] = true;
    body["stream_options"] = { include_usage: true };

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      { method: "POST", headers: this.buildHeaders(), body: JSON.stringify(body) },
    );

    let text = "";
    const toolCallAccumulator = new Map<number, {
      id: string; name: string; arguments: string;
      extraContent: Record<string, unknown>;
    }>();
    let finishReason = "stop";
    let inputTokens = 0;
    let outputTokens = 0;

    if (!response.body) throw new Error(`${this.name} streaming response has no body`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_SSE_BUFFER_BYTES) {
          reader.cancel();
          throw new Error(`${this.name} SSE buffer overflow`);
        }
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const chunk = JSON.parse(data) as GeminiStreamChunk;
            const delta = chunk.choices?.[0]?.delta;

            if (delta?.content) {
              text += delta.content;
              onChunk(delta.content);
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallAccumulator.has(idx)) {
                  toolCallAccumulator.set(idx, { id: "", name: "", arguments: "", extraContent: {} });
                }
                const existing = toolCallAccumulator.get(idx)!;
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;

                // Capture extra_content (thought_signature) from delta
                const { index: _, id: _id, function: _fn, ...rest } = tc;
                for (const [k, v] of Object.entries(rest)) {
                  existing.extraContent[k] = v;
                }
              }
            }

            if (chunk.choices?.[0]?.finish_reason) {
              finishReason = chunk.choices[0].finish_reason;
            }
            if (chunk.usage) {
              inputTokens = chunk.usage.prompt_tokens ?? 0;
              outputTokens = chunk.usage.completion_tokens ?? 0;
            }
          } catch {
            // Ignore malformed SSE chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls: ToolCall[] = Array.from(toolCallAccumulator.values())
      .filter((tc) => tc.id)
      .map((tc) => {
        let input: import("../../types/index.js").JsonObject;
        try {
          input = JSON.parse(tc.arguments) as import("../../types/index.js").JsonObject;
        } catch {
          input = { _rawArguments: tc.arguments };
        }
        const providerMetadata = Object.keys(tc.extraContent).length > 0 ? tc.extraContent : undefined;
        return providerMetadata
          ? { id: tc.id, name: tc.name, input, providerMetadata }
          : { id: tc.id, name: tc.name, input };
      });

    return {
      text,
      toolCalls,
      stopReason: OPENAI_STOP_REASON_MAP[finishReason] ?? "end_turn",
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    };
  }

  override async listModels(): Promise<string[]> {
    try {
      // Gemini uses an OpenAI-compatible endpoint — try the API first
      const models = await super.listModels();
      if (models.length > 1) return models;
    } catch {
      // Fall through to static list
    }
    return [
      "gemini-3-flash-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
    ];
  }

  /**
   * Override to echo back extra_content (thought_signature) from providerMetadata
   * on assistant tool_calls messages. Gemini 2.5+/3.x requires this or returns 400.
   */
  protected override buildAssistantToolCallMessage(msg: AssistantMessage): OpenAIMessage {
    return {
      role: "assistant",
      content: msg.content || null,
      tool_calls: msg.tool_calls!.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.input),
        },
        ...(tc.providerMetadata ?? {}),
      })),
    };
  }
}
