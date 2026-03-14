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
import type { MessageContent } from "./provider-core.interface.js";
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
    if (msg.role === "assistant" && msg.content) {
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
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const chunk = JSON.parse(data) as StreamSSEChunk;
            const delta = chunk.choices?.[0]?.delta;

            if (delta?.content) {
              text += delta.content;
              onChunk(delta.content);
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
      .map((tc) => {
        let input: import("../../types/index.js").JsonObject;
        try {
          input = JSON.parse(tc.arguments) as import("../../types/index.js").JsonObject;
        } catch {
          input = { _rawArguments: tc.arguments };
        }
        return { id: tc.id, name: tc.name, input };
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
        // Handle both simple string content and MessageContent[] format
        if (typeof msg.content === "string") {
          result.push({ role: "user", content: msg.content });
        } else if (Array.isArray(msg.content)) {
          // Convert MessageContent[] to OpenAI format
          for (const block of msg.content as MessageContent[]) {
            if (block.type === "text") {
              result.push({ role: "user", content: block.text });
            } else if (block.type === "image") {
              const imageContent = block.source.type === "base64"
                ? { type: "image_url" as const, image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } }
                : { type: "image_url" as const, image_url: { url: block.source.url } };
              result.push({ role: "user", content: [imageContent] as unknown as string });
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

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
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
