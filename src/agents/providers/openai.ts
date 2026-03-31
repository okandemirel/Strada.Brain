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
import { getLogger, getLoggerSafe } from "../../utils/logger.js";
import { convertToolDefinitions } from "./openai-compat.js";
import { fetchWithRetry as sharedFetchWithRetry } from "../../common/fetch-with-retry.js";
import {
  inspectOpenAiSubscriptionAuth,
  OPENAI_CHATGPT_AUTH_DEFAULT_FILE,
} from "../../common/openai-subscription-auth.js";

const MAX_RETRIES = 3;
export const MAX_SSE_BUFFER_BYTES = 1 * 1024 * 1024; // 1 MB
export const OPENAI_CHATGPT_RESPONSES_BASE_URL = "https://chatgpt.com/backend-api/codex";

/** Maps OpenAI finish_reason values to internal stop reasons */
export const OPENAI_STOP_REASON_MAP: Record<string, ProviderResponse["stopReason"]> = {
  tool_calls: "tool_use",
  length: "max_tokens",
};

/** Regex to match <reasoning> blocks injected by providers like DeepSeek/MiniMax */
const REASONING_BLOCK_RE = /<reasoning>\s*\n[\s\S]*?\n\s*<\/reasoning>\s*\n*/g;

export type OpenAIProviderAuth =
  | { mode?: "api-key"; apiKey: string }
  | {
      mode: "chatgpt-subscription";
      accessToken?: string;
      accountId?: string;
      authFile?: string;
    };

interface ResolvedChatGptAuth {
  accessToken: string;
  accountId: string;
}

type ChatGptSubscriptionAuth = Extract<
  OpenAIProviderAuth,
  { mode: "chatgpt-subscription" }
>;

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
  protected readonly auth: OpenAIProviderAuth;
  protected readonly model: string;
  protected readonly baseUrl: string;

  constructor(
    auth: string | OpenAIProviderAuth,
    model = "gpt-5.2",
    baseUrl = "https://api.openai.com/v1",
    label = "OpenAI",
  ) {
    this.name = label;
    this.auth = typeof auth === "string" ? { mode: "api-key", apiKey: auth } : auth;
    this.model = model;
    this.baseUrl = this.isChatGptSubscriptionMode() ? OPENAI_CHATGPT_RESPONSES_BASE_URL : baseUrl;
  }

  async chat(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    options?: { signal?: AbortSignal },
  ): Promise<ProviderResponse> {
    if (this.isChatGptSubscriptionMode()) {
      return this.chatViaChatGptResponses(systemPrompt, messages, tools);
    }

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
        headers: await this.buildHeaders(),
        body: JSON.stringify(body),
        ...(options?.signal ? { signal: options.signal } : {}),
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
    if (this.isChatGptSubscriptionMode()) {
      return this.chatViaChatGptResponses(systemPrompt, messages, tools, onChunk);
    }

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
        headers: await this.buildHeaders(),
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
      .map((tc, idx: number) => {
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

    // If reasoning was accumulated, embed in text so it survives the
    // conversation round-trip.  Providers like Kimi K2.5 require
    // reasoning_content echoed back on assistant messages — embedding in
    // text creates a redundant recovery path alongside providerMetadata.
    const finalText = reasoning
      ? `<reasoning>\n${reasoning}\n</reasoning>\n\n${text}`
      : text;

    return {
      text: finalText,
      toolCalls,
      stopReason,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }

  private async chatViaChatGptResponses(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    onChunk?: StreamCallback,
  ): Promise<ProviderResponse> {
    const logger = getLogger();
    const response = await this.fetchWithRetry(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: await this.buildHeaders(),
      body: JSON.stringify(this.buildChatGptResponsesRequest(systemPrompt, messages, tools)),
    });

    logger.debug(`${this.name} ChatGPT/Codex subscription API call`, {
      model: this.model,
      messageCount: messages.length,
      toolCount: tools.length,
    });

    if (!response.body) {
      throw new Error(`${this.name} subscription streaming response has no body`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const toolCallAccumulator = new Map<string, { id: string; name: string; arguments: string }>();
    let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    const processFrame = (frame: string): void => {
      const parsed = this.parseChatGptSseFrame(frame);
      if (!parsed) return;

      const { eventName, data } = parsed;
      if (eventName === "response.output_text.delta" && typeof data.delta === "string") {
        text += data.delta;
        onChunk?.(data.delta);
        return;
      }

      if (eventName === "response.output_item.added" && data.item?.type === "function_call") {
        toolCallAccumulator.set(data.item.id, {
          id: data.item.call_id ?? data.item.id,
          name: data.item.name ?? "",
          arguments: data.item.arguments ?? "",
        });
        return;
      }

      if (
        eventName === "response.function_call_arguments.delta"
        && typeof data.item_id === "string"
        && typeof data.delta === "string"
      ) {
        const existing = toolCallAccumulator.get(data.item_id);
        if (existing) {
          existing.arguments += data.delta;
        } else {
          toolCallAccumulator.set(data.item_id, {
            id: data.item_id,
            name: "",
            arguments: data.delta,
          });
        }
        return;
      }

      if (eventName === "response.output_item.done" && data.item?.type === "function_call") {
        toolCallAccumulator.set(data.item.id, {
          id: data.item.call_id ?? data.item.id,
          name: data.item.name ?? "",
          arguments: data.item.arguments ?? "",
        });
        return;
      }

      if (eventName === "response.completed" && data.response) {
        usage = {
          inputTokens: data.response.usage?.input_tokens ?? 0,
          outputTokens: data.response.usage?.output_tokens ?? 0,
          totalTokens: data.response.usage?.total_tokens ?? 0,
        };

        if (!text) {
          text = this.extractChatGptResponseText(data.response.output);
        }

        for (const outputItem of data.response.output ?? []) {
          if (outputItem.type !== "function_call") continue;
          toolCallAccumulator.set(outputItem.id, {
            id: outputItem.call_id,
            name: outputItem.name,
            arguments: outputItem.arguments ?? "",
          });
        }
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) {
            processFrame(buffer);
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_SSE_BUFFER_BYTES) {
          reader.cancel();
          throw new Error(`${this.name} SSE buffer overflow — stream appears malformed`);
        }

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          processFrame(frame);
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls: ToolCall[] = Array.from(toolCallAccumulator.values())
      .filter((call) => call.id && call.name)
      .map((call) => {
        let input: import("../../types/index.js").JsonObject;
        try {
          input = JSON.parse(call.arguments) as import("../../types/index.js").JsonObject;
        } catch {
          input = { _rawArguments: call.arguments };
        }
        return { id: call.id, name: call.name, input };
      });

    return {
      text,
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
      usage,
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
  protected async buildHeaders(): Promise<Record<string, string>> {
    if (!this.isChatGptSubscriptionMode()) {
      return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${(this.auth as { apiKey: string }).apiKey}`,
      };
    }

    const auth = this.resolveChatGptAuth();
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.accessToken}`,
      "ChatGPT-Account-Id": auth.accountId,
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
    const logger = getLoggerSafe();
    try {
      if (this.isChatGptSubscriptionMode()) {
        const authConfig = this.getChatGptSubscriptionAuth();
        const authInspection = inspectOpenAiSubscriptionAuth({
          authFile: authConfig.authFile,
          accessToken: authConfig.accessToken,
          accountId: authConfig.accountId,
          env: process.env,
        });
        if (!authInspection.ok) {
          logger.warn(`${this.name} health check failed: ${authInspection.detail}`);
          return false;
        }
        const response = await fetch(`${this.baseUrl}/responses`, {
          method: "POST",
          headers: await this.buildHeaders(),
          body: JSON.stringify(this.buildChatGptHealthCheckRequest()),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          logger.warn(`${this.name} health check failed: HTTP ${response.status}`);
          return false;
        }
        await response.body?.cancel();
        return true;
      }
      const response = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: await this.buildHeaders(),
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
      if (this.isChatGptSubscriptionMode()) {
        return [this.model];
      }
      const response = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: await this.buildHeaders(),
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

  private isChatGptSubscriptionMode(): boolean {
    return this.auth.mode === "chatgpt-subscription";
  }

  private getChatGptSubscriptionAuth(): ChatGptSubscriptionAuth {
    if (!this.isChatGptSubscriptionMode()) {
      throw new Error(`${this.name} is not configured for ChatGPT/Codex subscription auth`);
    }
    return this.auth as ChatGptSubscriptionAuth;
  }

  private resolveChatGptAuth(): ResolvedChatGptAuth {
    const authConfig = this.getChatGptSubscriptionAuth();

    if (authConfig.accessToken && authConfig.accountId) {
      const inspection = inspectOpenAiSubscriptionAuth({
        accessToken: authConfig.accessToken,
        accountId: authConfig.accountId,
        authFile: authConfig.authFile,
        env: process.env,
      });
      if (!inspection.ok || !inspection.accessToken || !inspection.accountId) {
        throw new Error(`${this.name} ${inspection.detail}`);
      }
      return {
        accessToken: inspection.accessToken,
        accountId: inspection.accountId,
      };
    }

    const inspection = inspectOpenAiSubscriptionAuth({
      authFile: authConfig.authFile ?? OPENAI_CHATGPT_AUTH_DEFAULT_FILE,
      env: process.env,
    });
    if (!inspection.ok || !inspection.accessToken || !inspection.accountId) {
      throw new Error(`${this.name} ${inspection.detail}`);
    }
    return {
      accessToken: inspection.accessToken,
      accountId: inspection.accountId,
    };
  }

  private buildChatGptResponsesRequest(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      instructions: systemPrompt,
      input: this.buildChatGptInput(messages),
      store: false,
      stream: true,
    };

    if (tools.length > 0) {
      body["tools"] = tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      }));
      body["tool_choice"] = "auto";
    }

    return body;
  }

  private buildChatGptHealthCheckRequest(): Record<string, unknown> {
    return {
      model: this.model,
      instructions: "Connectivity health check. Reply with OK.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "ping" }],
        },
      ],
      store: false,
      stream: true,
    };
  }

  private buildChatGptInput(messages: ConversationMessage[]): ChatGptInputItem[] {
    const items: ChatGptInputItem[] = [];

    for (const msg of messages) {
      if (msg.role === "assistant") {
        if (msg.content) {
          items.push({
            role: "assistant",
            content: [{ type: "output_text", text: msg.content }],
          });
        }
        if (msg.tool_calls) {
          for (const toolCall of msg.tool_calls) {
            items.push({
              type: "function_call",
              call_id: toolCall.id,
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.input),
            });
          }
        }
        continue;
      }

      if (typeof msg.content === "string") {
        items.push({
          role: "user",
          content: [{ type: "input_text", text: msg.content }],
        });
        continue;
      }

      if (!Array.isArray(msg.content)) {
        continue;
      }

      const userContent: ChatGptInputContentPart[] = [];
      for (const block of msg.content as MessageContent[]) {
        if (block.type === "text") {
          userContent.push({ type: "input_text", text: block.text });
          continue;
        }

        if (block.type === "image") {
          const imageUrl = block.source.type === "base64"
            ? `data:${block.source.media_type};base64,${block.source.data}`
            : block.source.url;
          userContent.push({ type: "input_image", image_url: imageUrl });
          continue;
        }

        if (block.type === "tool_result") {
          items.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output: typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content),
          });
        }
      }

      if (userContent.length > 0) {
        items.push({ role: "user", content: userContent });
      }
    }

    return items;
  }

  private parseChatGptSseFrame(frame: string): { eventName: string; data: ChatGptSseEventData } | null {
    const lines = frame
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);

    let eventName = "";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (!eventName || dataLines.length === 0) {
      return null;
    }

    try {
      return { eventName, data: JSON.parse(dataLines.join("\n")) as ChatGptSseEventData };
    } catch {
      return null;
    }
  }

  private extractChatGptResponseText(output: ChatGptOutputItem[] | undefined): string {
    if (!output) return "";
    const texts: string[] = [];
    for (const item of output) {
      if (item.type !== "message") continue;
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && typeof part.text === "string") {
          texts.push(part.text);
        }
      }
    }
    return texts.join("");
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

interface ChatGptInputTextPart {
  type: "input_text";
  text: string;
}

interface ChatGptAssistantTextPart {
  type: "output_text";
  text: string;
}

interface ChatGptInputImagePart {
  type: "input_image";
  image_url: string;
}

type ChatGptInputContentPart = ChatGptInputTextPart | ChatGptInputImagePart;
type ChatGptAssistantContentPart = ChatGptAssistantTextPart;

type ChatGptInputItem =
  | {
      role: "user";
      content: ChatGptInputContentPart[];
    }
  | {
      role: "assistant";
      content: ChatGptAssistantContentPart[];
    }
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string;
    };

interface ChatGptOutputTextPart {
  type: "output_text";
  text: string;
}

type ChatGptOutputItem =
  | {
      id: string;
      type: "message";
      role: "assistant";
      content?: ChatGptOutputTextPart[];
    }
  | {
      id: string;
      type: "function_call";
      call_id: string;
      name: string;
      arguments?: string;
    };

interface ChatGptSseEventData {
  delta?: string;
  item_id?: string;
  item?: {
    id: string;
    type: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
    output?: ChatGptOutputItem[];
  };
}
