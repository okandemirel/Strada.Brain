import type {
  IAIProvider,
  ConversationMessage,
  ToolDefinition,
  ProviderResponse,
  ToolCall,
  StreamCallback,
  ProviderCapabilities,
  IStreamingProvider,
} from "./provider.interface.js";
import type { MessageContent, AssistantMessage } from "./provider-core.interface.js";
import { getLogger } from "../../utils/logger.js";
import { convertToolDefinitions } from "./openai-compat.js";
import { fetchWithRetry as sharedFetchWithRetry } from "../../common/fetch-with-retry.js";

const MAX_RETRIES = 3;
export const MAX_SSE_BUFFER_BYTES = 1 * 1024 * 1024; // 1 MB

/** Maps OpenAI finish_reason values to internal stop reasons */
export const OPENAI_STOP_REASON_MAP: Record<string, ProviderResponse["stopReason"]> = {
  tool_calls: "tool_use",
  length: "max_tokens",
};

/** Regex to match <reasoning> blocks injected by providers like DeepSeek/MiniMax */
const REASONING_BLOCK_RE = /<reasoning>\s*\n[\s\S]*?\n\s*<\/reasoning>\s*\n*/g;

/** Strip <reasoning> blocks from assistant messages before replay */
export function stripReasoningBlocks(messages: OpenAIMessage[]): void {
  for (const msg of messages) {
    if (msg.role === "assistant" && typeof msg.content === "string") {
      msg.content = msg.content.replace(REASONING_BLOCK_RE, "");
    }
  }
}

/**
 * OpenAI-compatible provider.
 * Works with OpenAI API and any compatible endpoint (Azure, Together, etc.).
 */
export class OpenAIProvider implements IAIProvider, IStreamingProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities = {
    maxTokens: 4096,
    streaming: true,
    structuredStreaming: false,
    toolCalling: true,
    vision: true,
    systemPrompt: true,
    contextWindow: 1_050_000,
    thinkingSupported: false,
    specialFeatures: ["function_calling", "json_mode"],
  };
  protected readonly apiKey: string;
  protected readonly model: string;
  protected readonly baseUrl: string;

  constructor(
    apiKey: string,
    model = "gpt-5.2",
    baseUrl = "https://api.openai.com/v1",
    label = "OpenAI",
  ) {
    this.name = label;
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async chat(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
  ): Promise<ProviderResponse> {
    const logger = getLogger();

    const openaiMessages = this.buildMessages(systemPrompt, messages);
    const openaiTools = convertToolDefinitions(tools);

    logger.debug(`${this.name} API call`, {
      model: this.model,
      messageCount: openaiMessages.length,
      toolCount: tools.length,
    });

    const body = this.buildRequestBody(openaiMessages, openaiTools);

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      },
    );

    const data = (await response.json()) as OpenAIResponse;
    return this.parseResponse(data);
  }

  async chatStream(
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
      {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      },
    );

    let text = "";
    let reasoning = "";
    const toolCallAccumulator = new Map<number, { id: string; name: string; arguments: string }>();
    let finishReason = "stop";
    let inputTokens = 0;
    let outputTokens = 0;

    if (!response.body) {
      throw new Error(`${this.name} streaming response has no body`);
    }
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
          throw new Error(`${this.name} SSE buffer overflow — stream appears malformed`);
        }
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          // Accept both "data: " (OpenAI) and "data:" (Kimi) SSE formats
          if (!line.startsWith("data:")) continue;
          const data = (line.startsWith("data: ") ? line.slice(6) : line.slice(5)).trim();
          if (data === "[DONE]") continue;

          try {
            const chunk = JSON.parse(data) as StreamSSEChunk;
            const delta = chunk.choices?.[0]?.delta;

            const streamText = this.extractStreamText(delta);
            if (streamText) {
              text += streamText;
              onChunk(streamText);
            }

            const streamReasoning = this.extractStreamReasoning(delta as Record<string, unknown>);
            if (streamReasoning) {
              reasoning += streamReasoning;
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallAccumulator.has(idx)) {
                  toolCallAccumulator.set(idx, { id: "", name: "", arguments: "" });
                }
                const existing = toolCallAccumulator.get(idx)!;
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
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
      .map((tc: any, idx: number) => {
        let input: import("../../types/index.js").JsonObject;
        try {
          input = JSON.parse(tc.arguments) as import("../../types/index.js").JsonObject;
        } catch {
          input = { _rawArguments: tc.arguments };
        }
        // Attach accumulated reasoning to first tool call (for providers like Kimi K2.5)
        const providerMetadata = idx === 0 && reasoning ? { reasoning_content: reasoning } : undefined;
        return providerMetadata
          ? { id: tc.id, name: tc.name, input, providerMetadata }
          : { id: tc.id, name: tc.name, input };
      });

    const stopReason = OPENAI_STOP_REASON_MAP[finishReason] ?? "end_turn";

    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }

  protected buildMessages(systemPrompt: string, messages: ConversationMessage[]): OpenAIMessage[] {
    const result: OpenAIMessage[] = [{ role: "system", content: systemPrompt }];

    for (const msg of messages) {
      if (msg.role === "user") {
        this.appendUserMessage(result, msg);
      } else if (msg.role === "assistant") {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          result.push(this.buildAssistantToolCallMessage(msg));
        } else {
          result.push({ role: "assistant", content: msg.content });
        }
      }
    }

    return result;
  }

  /**
   * Convert a user ConversationMessage into OpenAI message(s).
   * Handles tool_result reordering, text/image content parts, and single-text collapse.
   * Shared by all OpenAI-compatible providers.
   */
  protected appendUserMessage(result: OpenAIMessage[], msg: ConversationMessage): void {
    if (typeof msg.content === "string") {
      result.push({ role: "user", content: msg.content });
      return;
    }
    if (!Array.isArray(msg.content)) return;

    // Emit tool_result blocks FIRST as role:"tool" messages so they sit
    // directly after the preceding assistant tool_calls message. OpenAI-
    // compatible APIs require tool responses immediately after the
    // assistant message — interleaving user messages breaks the pairing.
    const contentParts: OpenAIContentPart[] = [];
    for (const block of msg.content as MessageContent[]) {
      if (block.type === "tool_result") {
        result.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: block.content,
        });
      } else if (block.type === "text") {
        contentParts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        const url = block.source.type === "base64"
          ? `data:${block.source.media_type};base64,${block.source.data}`
          : block.source.url;
        contentParts.push({ type: "image_url", image_url: { url } });
      }
    }
    if (contentParts.length > 0) {
      // Optimisation: collapse to plain string when only a single text part
      if (contentParts.length === 1 && contentParts[0]!.type === "text") {
        result.push({ role: "user", content: contentParts[0]!.text });
      } else {
        result.push({ role: "user", content: contentParts });
      }
    }
  }

  /**
   * Build an assistant message with tool_calls.
   * Subclasses override to attach provider-specific metadata (e.g., thought_signature, reasoning_content).
   */
  protected buildAssistantToolCallMessage(msg: AssistantMessage): OpenAIMessage {
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
      })),
    };
  }

  /**
   * Build HTTP headers for API requests.
   * Subclasses can override to add provider-specific headers (e.g., User-Agent).
   */
  protected buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  /**
   * Extract text from a streaming SSE delta object.
   * Subclasses can override to handle provider-specific fields.
   */
  protected extractStreamText(delta: Record<string, unknown> | undefined): string | undefined {
    return (delta?.content as string) || undefined;
  }

  /**
   * Extract reasoning/thinking content from a streaming SSE delta.
   * Accumulated separately from user-visible text and attached to tool calls.
   * Override in subclasses for providers with thinking mode (e.g., Kimi K2.5).
   */
  protected extractStreamReasoning(delta: Record<string, unknown> | undefined): string | undefined {
    void delta; // unused in base — subclasses override
    return undefined;
  }

  protected buildRequestBody(
    messages: OpenAIMessage[],
    tools: unknown,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.capabilities.maxTokens,
      messages,
    };
    if (tools) {
      body["tools"] = tools;
    }
    return body;
  }

  async healthCheck(): Promise<boolean> {
    const logger = getLogger();
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        logger.warn(`${this.name} health check failed: HTTP ${response.status}`);
        return false;
      }
      return true;
    } catch (err) {
      logger.warn(`${this.name} health check failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return [this.model];
      const data = (await response.json()) as { data?: Array<{ id: string }> };
      return (data.data || []).map((m) => m.id).sort();
    } catch {
      return [this.model];
    }
  }

  /**
   * Fetch with exponential backoff retry for transient errors (429, 5xx).
   */
  protected async fetchWithRetry(
    url: string,
    options: RequestInit,
  ): Promise<Response> {
    return sharedFetchWithRetry(url, options, {
      maxRetries: MAX_RETRIES,
      callerName: this.name,
    });
  }

  protected parseResponse(data: OpenAIResponse): ProviderResponse {
    const choice = data.choices[0];
    if (!choice) {
      throw new Error(`${this.name} returned empty choices`);
    }

    const message = choice.message;
    const text = message.content ?? "";
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc: any) => {
      let input: import("../../types/index.js").JsonObject;
      try {
        input = JSON.parse(tc.function.arguments) as import("../../types/index.js").JsonObject;
      } catch {
        input = { _rawArguments: tc.function.arguments };
      }
      return { id: tc.id, name: tc.function.name, input };
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
}

// --- OpenAI API types ---

/** Content part for multimodal messages (text + image) */
export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    [key: string]: unknown;
  }>;
  tool_call_id?: string;
}

export interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string | null;
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
  };
}

/** SSE streaming chunk format */
interface StreamSSEChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}
