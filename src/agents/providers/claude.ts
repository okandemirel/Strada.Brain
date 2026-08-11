import Anthropic from "@anthropic-ai/sdk";
import type {
  IAIProvider,
  IStreamingProvider,
  ConversationMessage,
  ToolDefinition,
  ProviderResponse,
  ToolCall,
  StreamCallback,
  ProviderCapabilities,
} from "./provider.interface.js";
import type { MessageContent, TokenUsage } from "./provider-core.interface.js";
import { getLogger, getLoggerSafe } from "../../utils/logger.js";

/**
 * Claude AI provider using the Anthropic SDK.
 * Primary provider for Strada Brain.
 */
export class ClaudeProvider implements IAIProvider, IStreamingProvider {
  readonly name = "claude";
  readonly capabilities: ProviderCapabilities = {
    maxTokens: 8192,
    streaming: true,
    structuredStreaming: false,
    toolCalling: true,
    vision: true,
    systemPrompt: true,
    contextWindow: 1_000_000,
    thinkingSupported: true,
    specialFeatures: ["prompt_caching", "adaptive_thinking", "vision", "pdf_input"],
  };
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(
    auth:
      | string
      | { mode: "api-key"; apiKey: string }
      | { mode: "claude-subscription"; authToken: string },
    model = "claude-sonnet-5",
  ) {
    let normalizedAuth: { apiKey: string } | { authToken: string };
    if (typeof auth === "string") {
      normalizedAuth = { apiKey: auth };
    } else if (auth.mode === "claude-subscription") {
      normalizedAuth = { authToken: auth.authToken };
    } else {
      normalizedAuth = { apiKey: auth.apiKey };
    }
    this.client = new Anthropic(normalizedAuth);
    this.model = model;
  }

  async chat(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    options?: { signal?: AbortSignal },
  ): Promise<ProviderResponse> {
    const logger = getLogger();

    const anthropicMessages = this.buildMessages(messages);
    const anthropicTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }));

    logger.debug("Claude API call", {
      model: this.model,
      messageCount: anthropicMessages.length,
      toolCount: anthropicTools.length,
    });

    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: this.capabilities.maxTokens,
        system: systemPrompt,
        messages: anthropicMessages,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      },
      options?.signal ? { signal: options.signal } : undefined,
    );

    return this.parseResponse(response);
  }

  async chatStream(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    onChunk: StreamCallback,
    options?: { signal?: AbortSignal },
  ): Promise<ProviderResponse> {
    const logger = getLogger();

    const anthropicMessages = this.buildMessages(messages);
    const anthropicTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }));

    logger.debug("Claude streaming API call", {
      model: this.model,
      messageCount: anthropicMessages.length,
    });

    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: this.capabilities.maxTokens,
        system: systemPrompt,
        messages: anthropicMessages,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      },
      options?.signal ? { signal: options.signal } : undefined,
    );

    stream.on("text", (text) => {
      onChunk(text);
    });

    const response = await stream.finalMessage();
    return this.parseResponse(response);
  }

  async healthCheck(): Promise<boolean> {
    const logger = getLoggerSafe();
    try {
      // List models to verify API key — no tokens consumed
      await this.client.models.list({ limit: 1 });
      return true;
    } catch (err) {
      logger.warn("Claude health check failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const page = await this.client.models.list({ limit: 100 }, { signal: AbortSignal.timeout(10_000) });
      const models = page.data.map((m) => m.id).sort();
      return models.length > 0 ? models : this.fallbackModels();
    } catch {
      return this.fallbackModels();
    }
  }

  private fallbackModels(): string[] {
    // Offline fallback when models.list() is unreachable. Anthropic ids are
    // complete as published — appending a date suffix to an alias produces an
    // id that does not resolve, which is how the previous entries here 404'd.
    return [
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ];
  }

  private buildMessages(messages: ConversationMessage[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === "user") {
        // Handle both simple string content and MessageContent[] format
        if (typeof msg.content === "string") {
          result.push({ role: "user", content: msg.content });
        } else if (Array.isArray(msg.content)) {
          // Convert MessageContent[] to Anthropic format
          const content: Anthropic.ContentBlockParam[] = [];
          for (const block of msg.content as MessageContent[]) {
            if (block.type === "text") {
              content.push({ type: "text", text: block.text });
            } else if (block.type === "image") {
              let source: Anthropic.Base64ImageSource | Anthropic.URLImageSource;
              switch (block.source.type) {
                case "base64":
                  source = {
                    type: "base64",
                    media_type: block.source.media_type as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                    data: block.source.data,
                  };
                  break;
                default:
                  source = {
                    type: "url",
                    url: block.source.url,
                  };
                  break;
              }
              content.push({ type: "image", source });
            } else if (block.type === "tool_result") {
              content.push({
                type: "tool_result",
                tool_use_id: block.tool_use_id,
                content: block.content,
                is_error: block.is_error,
              });
            }
          }
          if (content.length > 0) {
            result.push({ role: "user", content });
          }
        }
      } else if (msg.role === "assistant") {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const content: Anthropic.ContentBlockParam[] = [];

          if (msg.content) {
            content.push({ type: "text", text: msg.content });
          }

          for (const tc of msg.tool_calls) {
            content.push({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: tc.input,
            });
          }

          result.push({ role: "assistant", content });
        } else {
          result.push({ role: "assistant", content: msg.content });
        }
      }
    }

    return result;
  }

  /** Maps Anthropic stop_reason values to internal stop reasons */
  private static readonly STOP_REASON_MAP: Record<string, ProviderResponse["stopReason"]> = {
    tool_use: "tool_use",
    max_tokens: "max_tokens",
  };

  private parseResponse(response: Anthropic.Message): ProviderResponse {
    let text = "";
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as import("../../types/index.js").JsonObject,
        });
      }
    }

    const stopReason =
      (response.stop_reason ? ClaudeProvider.STOP_REASON_MAP[response.stop_reason] : undefined) ?? "end_turn";

    return {
      text,
      toolCalls,
      stopReason,
      usage: buildUsage(response.usage),
    };
  }
}

/**
 * Anthropic usage → TokenUsage.
 *
 * `input_tokens` is the UNCACHED remainder only: the true prompt size is
 * `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
 * Summing only the first two fields under-reports the prompt as soon as prompt
 * caching is enabled, which would silently under-bill every cost estimate and
 * budget check that reads totalTokens.
 *
 * The cache counters are also the only way to tell whether caching is working
 * at all — a cache_read of zero across repeated requests means a silent
 * invalidator is in the prefix, and without exporting the number there is
 * nothing to notice.
 */
function buildUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): TokenUsage {
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + cacheCreation + cacheRead + usage.output_tokens,
    ...(cacheCreation > 0 ? { cacheCreationInputTokens: cacheCreation } : {}),
    ...(cacheRead > 0 ? { cacheReadInputTokens: cacheRead } : {}),
  };
}
