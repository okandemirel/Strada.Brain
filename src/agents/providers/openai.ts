import type {
  IAIProvider,
  ConversationMessage,
  ToolDefinition,
  ProviderResponse,
  ToolCall,
  StreamCallback,
  ProviderCapabilities,
  IStreamingProvider,
  ProviderCallOptions,
  ResponseSchema,
  ProviderCallHooks,
} from "./provider.interface.js";
import type { MessageContent, AssistantMessage } from "./provider-core.interface.js";
import { getLogger, getLoggerSafe } from "../../utils/logger.js";
import { convertToolDefinitions } from "./openai-compat.js";
import { fetchWithRetry as sharedFetchWithRetry } from "../../common/fetch-with-retry.js";
import {
  ensureOpenAiSubscriptionAuth,
  refreshOpenAiSubscriptionToken,
  expandHomePath,
  OPENAI_CHATGPT_AUTH_DEFAULT_FILE,
} from "../../common/openai-subscription-auth.js";
import { resolveCodexCliVersion } from "../../common/openai-codex-login.js";
import {
  codexModelRejectionMessage,
  isRawCodexModelRejection,
} from "./codex-model-rejection.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_RETRIES = 3;
export const MAX_SSE_BUFFER_BYTES = 1 * 1024 * 1024; // 1 MB

/**
 * Headers common to every request shape (api-key and subscription). Spread into
 * each branch of buildHeaders() so a change here can't diverge between them.
 */
const OPENAI_BASE_HEADERS = { "Content-Type": "application/json" } as const;
export const OPENAI_CHATGPT_RESPONSES_BASE_URL = "https://chatgpt.com/backend-api/codex";

/**
 * Static client-identity string the official codex CLI sends as `originator`.
 * The Codex backend GATES the consumer ChatGPT/Codex subscription token on this
 * (and a codex-shaped User-Agent / OpenAI-Beta / session_id) — without it the
 * very same valid token is rejected with HTTP 401. This is a NON-SECRET identity
 * marker, not a credential.
 *
 * NOTE: this tracks codex's UNDOCUMENTED wire protocol and is therefore brittle —
 * it may need updating if codex changes the headers it sends.
 */
export const CODEX_ORIGINATOR = "codex_cli_rs";
/** Responses-API beta marker the codex CLI sends. */
export const CODEX_OPENAI_BETA = "responses=experimental";

/** Maps OpenAI finish_reason values to internal stop reasons */
export const OPENAI_STOP_REASON_MAP: Record<string, ProviderResponse["stopReason"]> = {
  tool_calls: "tool_use",
  length: "max_tokens",
  content_filter: "end_turn",
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
    structuredOutput: true,
    specialFeatures: ["function_calling", "json_mode", "structured_output"],
  };
  protected readonly auth: OpenAIProviderAuth;
  protected readonly model: string;
  protected readonly baseUrl: string;
  /**
   * The model the ChatGPT/Codex subscription `/responses` path is PINNED to.
   *
   * INVARIANT: a consumer ChatGPT/Codex subscription only serves a small set of
   * Codex-enabled models, and rejects anything else with HTTP 400 ("The 'X' model
   * is not supported when using Codex with a ChatGPT account."). Strada routes by
   * per-chat/delegation preference, which can construct a fresh OpenAIProvider with
   * an arbitrary model override (e.g. the global gpt-5.2 fallback) even though the
   * subscription was configured (and booted ready) on a different Codex-supported
   * model (e.g. gpt-5.4). Sending that override would 400 and churn provider health.
   *
   * So the subscription request model is resolved ONCE at construction to the
   * user's configured Codex model — `OPENAI_MODEL` env when set (the SAME value the
   * boot-time preflight used to verify the subscription is healthy), falling back to
   * the constructor model. A churned per-call override that the subscription cannot
   * serve is therefore ignored in favour of the known-good configured model. Only
   * relevant in subscription mode; api-key mode always uses `this.model` verbatim so
   * per-call/override models keep working.
   */
  private readonly chatGptModel: string;
  /** Human-readable reason the last healthCheck() failed (for accurate preflight diagnostics). */
  private lastHealthDetail?: string;
  /**
   * Stable per-instance session id sent as the codex `session_id` identity header
   * in subscription mode. Generated ONCE in the constructor so it stays constant
   * across a conversation's turns (matching how the codex CLI keeps one session id
   * for the life of a run), and differs across provider instances.
   */
  private readonly sessionId = randomUUID();

  /** Returns the reason the most recent healthCheck() failed, if any. */
  getLastHealthDetail(): string | undefined {
    return this.lastHealthDetail;
  }

  /**
   * Codex-shaped User-Agent (`codex_cli_rs/<version>`) sent in subscription mode.
   * Resolved lazily on first use (never at construction, never per request) and
   * only in subscription mode, so construction stays pure and api-key callers
   * never pay the version lookup. The underlying resolveCodexCliVersion() is
   * itself memoized, so this is computed at most once per process.
   */
  private codexUserAgent?: string;

  /**
   * Lazily resolve the codex-shaped User-Agent, memoizing the result on the
   * instance. Only called from the subscription branch of buildHeaders().
   */
  private getCodexUserAgent(): string {
    if (this.codexUserAgent === undefined) {
      this.codexUserAgent = `${CODEX_ORIGINATOR}/${resolveCodexCliVersion()}`;
    }
    return this.codexUserAgent;
  }

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
    // Pin the subscription `/responses` model to the user-configured Codex model
    // (OPENAI_MODEL), so a churned per-chat/delegation model override that the
    // subscription cannot serve never reaches the request. See `chatGptModel`.
    const envModel = this.isChatGptSubscriptionMode()
      ? process.env["OPENAI_MODEL"]?.trim()
      : undefined;
    this.chatGptModel = envModel && envModel.length > 0 ? envModel : model;
    // The codex-shaped User-Agent is resolved lazily on first request via
    // getCodexUserAgent() — only in subscription mode — so construction stays
    // pure and api-key mode never pays the version lookup.
  }

  async chat(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    options?: ProviderCallOptions,
  ): Promise<ProviderResponse> {
    if (this.isChatGptSubscriptionMode()) {
      return this.chatViaChatGptResponses(
        systemPrompt, messages, tools, undefined, options?.signal, options?.responseSchema,
      );
    }

    const logger = getLogger();

    const openaiMessages = this.buildMessages(systemPrompt, messages);
    const openaiTools = convertToolDefinitions(tools);

    logger.debug(`${this.name} API call`, {
      model: this.model,
      messageCount: openaiMessages.length,
      toolCount: tools.length,
    });

    const body = this.buildRequestBody(openaiMessages, openaiTools, options?.responseSchema);

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: await this.buildHeaders(),
        body: JSON.stringify(body),
        signal: options?.signal,
      },
      { onBackoff: options?.onBackoff },
    );

    const data = (await response.json()) as OpenAIResponse;
    return this.parseResponse(data);
  }

  async chatStream(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    onChunk: StreamCallback,
    options?: ProviderCallOptions,
  ): Promise<ProviderResponse> {
    if (this.isChatGptSubscriptionMode()) {
      return this.chatViaChatGptResponses(
        systemPrompt, messages, tools, onChunk, options?.signal, options?.responseSchema,
      );
    }

    const logger = getLogger();

    const openaiMessages = this.buildMessages(systemPrompt, messages);
    const openaiTools = convertToolDefinitions(tools);

    logger.debug(`${this.name} streaming API call`, {
      model: this.model,
      messageCount: openaiMessages.length,
    });

    const body = this.buildRequestBody(openaiMessages, openaiTools, options?.responseSchema);
    body["stream"] = true;
    body["stream_options"] = { include_usage: true };

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: await this.buildHeaders(),
        body: JSON.stringify(body),
        signal: options?.signal,
      },
      { onBackoff: options?.onBackoff },
    );

    let text = "";
    let reasoning = "";
    const toolCallAccumulator = new Map<number, { id: string; name: string; arguments: string }>();
    let finishReason = "stop";
    let inputTokens = 0;
    let outputTokens = 0;
    // OpenAI caches prompt prefixes automatically — no request-side opt-in —
    // but the provider never surfaced the number, so the saving was invisible.
    // This is the cached share of prompt_tokens, not an addition to it.
    let cachedTokens = 0;

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
              // Reasoning activity counts as progress — prevents stall timeouts
              // during Kimi K2.5 thinking phases where reasoning_content streams
              // but content is empty.
              onChunk("");
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
              cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
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
        ...(cachedTokens > 0 ? { cacheReadInputTokens: cachedTokens } : {}),
      },
    };
  }

  private async chatViaChatGptResponses(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    onChunk?: StreamCallback,
    signal?: AbortSignal,
    responseSchema?: ResponseSchema,
  ): Promise<ProviderResponse> {
    const logger = getLogger();
    let response: Response;
    try {
      response = await this.fetchWithRetry(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: await this.buildHeaders(),
        body: JSON.stringify(this.buildChatGptResponsesRequest(systemPrompt, messages, tools, responseSchema)),
        signal,
      });
    } catch (err) {
      // fetchWithRetry throws on a non-retryable non-ok status (e.g. a 400 whose body
      // is the Codex "model is not supported when using Codex with a ChatGPT account").
      // SAFETY NET: rewrite that raw transport error into the clear, actionable message
      // (the same guidance the health probe surfaces) so the user is told to set a
      // Codex-supported model / use API-key mode — and so the FallbackChain recognises
      // it as a static CONFIG mismatch (non-retryable, no health churn) instead of a
      // transient model error that would collapse the chain to a false "no available
      // provider". We do NOT loop: the request already used the single pinned model.
      throw this.rewriteChatGptModelRejection(err);
    }

    // Refresh-on-401: a server-invalidated/rotated subscription token (whose local
    // JWT is not yet expired, so ensureOpenAiSubscriptionAuth won't have refreshed
    // it) returns 401/403 here. Force a refresh via the stored refresh_token and
    // retry once before surfacing an auth error.
    if ((response.status === 401 || response.status === 403) && await this.tryRefreshChatGptToken()) {
      await response.body?.cancel().catch(() => {});
      response = await this.fetchWithRetry(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: await this.buildHeaders(),
        body: JSON.stringify(this.buildChatGptResponsesRequest(systemPrompt, messages, tools, responseSchema)),
        signal,
      });
    }
    if (!response.ok) {
      // Defensive net: in practice fetchWithRetry already THROWS on every non-ok,
      // non-retryable status (401/403/400/404), so this branch is not reached on the
      // live chat path — a 400/404 model rejection is surfaced by the catch above via
      // rewriteChatGptModelRejection, and an auth 401/403 propagates as the thrown
      // transport error. (describeChatGptHealthFailure's 400/404 model-rejection
      // branch is exercised by healthCheck(), which uses a raw fetch, not this path.)
      const detail = await this.describeChatGptHealthFailure(response);
      throw new Error(`${this.name} ${detail}`);
    }

    logger.debug(`${this.name} ChatGPT/Codex subscription API call`, {
      model: this.model,
      messageCount: messages.length,
      toolCount: tools.length,
    });

    if (!response.body) {
      throw new Error(`${this.name} subscription streaming response has no body`);
    }

    const reader = response.body.getReader();
    // Honor the caller's AbortSignal (user/task cancel or the orchestrator's
    // stall-timeout guard): cancel the in-flight read so a stalled stream cannot
    // block on reader.read() until the server closes the socket (connection leak).
    const onAbort = (): void => { void reader.cancel().catch(() => {}); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const toolCallAccumulator = new Map<string, { id: string; name: string; arguments: string }>();
    let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    const processFrame = (frame: string): void => {
      const parsed = this.parseChatGptSseFrame(frame);
      if (!parsed) return;

      const { eventName, data } = parsed;

      // The Codex/ChatGPT subscription backend emits `keepalive` heartbeat frames
      // (~every 30s) during the model's silent reasoning phase — gpt-5.x models can
      // "think" for tens of seconds to minutes producing no output_text, broken only
      // by these heartbeats. Surface them as stream progress (an empty chunk) so the
      // orchestrator's stall-timeout watchdog (markProgress) treats the model as
      // alive instead of aborting it mid-reasoning. Without this the request is
      // wrongly killed as a stall and the whole provider chain collapses. Mirrors the
      // reasoning_content progress signal in the OpenAI-compatible streaming path.
      if (eventName === "keepalive") {
        onChunk?.("");
        return;
      }

      // Reasoning-summary deltas (emitted when `reasoning.summary` is requested)
      // stream densely during the silent think phase. They carry no user-visible
      // answer text, so surface them as an empty liveness heartbeat — the watchdog
      // stays alive on the long thinking window without flipping to the stall window.
      if (eventName === "response.reasoning_summary_text.delta") {
        onChunk?.("");
        return;
      }

      if (eventName === "response.output_text.delta" && typeof data.delta === "string") {
        text += data.delta;
        onChunk?.(data.delta);
        return;
      }

      if (eventName === "response.output_item.added" && data.item?.type === "function_call") {
        // A tool-call-only turn streams these events but no output_text — without a
        // heartbeat the watchdog would see no progress while large tool-call JSON
        // arguments stream. Treat as a liveness heartbeat (no visible answer text).
        onChunk?.("");
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
        onChunk?.("");
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
        onChunk?.("");
        toolCallAccumulator.set(data.item.id, {
          id: data.item.call_id ?? data.item.id,
          name: data.item.name ?? "",
          arguments: data.item.arguments ?? "",
        });
        return;
      }

      if (eventName === "response.completed" && data.response) {
        const cached = data.response.usage?.input_tokens_details?.cached_tokens ?? 0;
        usage = {
          inputTokens: data.response.usage?.input_tokens ?? 0,
          outputTokens: data.response.usage?.output_tokens ?? 0,
          totalTokens: data.response.usage?.total_tokens ?? 0,
          ...(cached > 0 ? { cacheReadInputTokens: cached } : {}),
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
        if (signal?.aborted) break;
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
      if (signal) signal.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }

    if (signal?.aborted) {
      throw new DOMException("ChatGPT subscription stream aborted", "AbortError");
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
          content: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
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
        ...OPENAI_BASE_HEADERS,
        Authorization: `Bearer ${(this.auth as { apiKey: string }).apiKey}`,
      };
    }

    const auth = await this.resolveChatGptAuth();
    // The Codex backend gates the consumer subscription token on the client-identity
    // headers the official codex CLI sends. Without them the SAME valid token is
    // rejected with HTTP 401. These are all NON-SECRET identity markers — the bearer
    // token (the only credential) is attached exactly as before and never logged.
    // This mirrors codex's UNDOCUMENTED wire protocol and is therefore brittle.
    return {
      ...OPENAI_BASE_HEADERS,
      Authorization: `Bearer ${auth.accessToken}`,
      "ChatGPT-Account-Id": auth.accountId,
      // codex sends the account id lowercased too; sending both is harmless and
      // keeps us byte-for-byte aligned with the CLI's request shape.
      "chatgpt-account-id": auth.accountId,
      // Primary identity gate — a static marker, identical to codex_cli_rs.
      originator: CODEX_ORIGINATOR,
      // codex-shaped User-Agent, resolved lazily + memoized on first use.
      "User-Agent": this.getCodexUserAgent(),
      "OpenAI-Beta": CODEX_OPENAI_BETA,
      // Stable per-instance session id (constant across this conversation's turns).
      session_id: this.sessionId,
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
    responseSchema?: ResponseSchema,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.capabilities.maxTokens,
      messages,
    };
    if (tools) {
      body["tools"] = tools;
    }
    if (responseSchema) {
      // `strict: true` is what makes this constrained decoding rather than a
      // hint. It requires the schema to be an object with
      // additionalProperties:false and every property listed in `required` —
      // ResponseSchema's docs say so, because a schema that violates it is
      // rejected by the API rather than silently downgraded.
      body["response_format"] = {
        type: "json_schema",
        json_schema: {
          name: responseSchema.name,
          schema: responseSchema.schema,
          strict: true,
        },
      };
    }
    return body;
  }

  async healthCheck(): Promise<boolean> {
    const logger = getLoggerSafe();
    this.lastHealthDetail = undefined;
    try {
      if (this.isChatGptSubscriptionMode()) {
        const authConfig = this.getChatGptSubscriptionAuth();
        const authInspection = await ensureOpenAiSubscriptionAuth({
          authFile: authConfig.authFile,
          accessToken: authConfig.accessToken,
          accountId: authConfig.accountId,
          env: process.env,
        });
        if (!authInspection.ok) {
          logger.warn(`${this.name} health check failed: ${authInspection.detail}`);
          return false;
        }
        let response = await fetch(`${this.baseUrl}/responses`, {
          method: "POST",
          headers: await this.buildHeaders(),
          body: JSON.stringify(this.buildChatGptHealthCheckRequest()),
          signal: AbortSignal.timeout(10_000),
        });
        // Refresh-on-401: the server can invalidate/rotate a token whose local JWT
        // is not yet expired, so the ensureOpenAiSubscriptionAuth above won't have
        // refreshed it. Force a refresh via the stored refresh_token and retry once.
        if ((response.status === 401 || response.status === 403) && await this.tryRefreshChatGptToken()) {
          await response.body?.cancel().catch(() => {});
          response = await fetch(`${this.baseUrl}/responses`, {
            method: "POST",
            headers: await this.buildHeaders(),
            body: JSON.stringify(this.buildChatGptHealthCheckRequest()),
            signal: AbortSignal.timeout(10_000),
          });
        }
        if (!response.ok) {
          this.lastHealthDetail = await this.describeChatGptHealthFailure(response);
          logger.warn(`${this.name} health check failed: ${this.lastHealthDetail}`);
          return false;
        }
        await response.body?.cancel();
        return true;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await fetch(`${this.baseUrl}/models`, {
            method: "GET",
            headers: await this.buildHeaders(),
            signal: AbortSignal.timeout(10_000),
          });
          if (response.ok) return true;
          if (response.status === 429 && attempt === 0) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          logger.warn(`${this.name} health check failed: HTTP ${response.status}`);
          return false;
        } catch {
          if (attempt === 0) { await new Promise(r => setTimeout(r, 2000)); continue; }
          return false;
        }
      }
      return false;
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
        return this.listChatGptSubscriptionModels();
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
   * Discover the available Codex models for a ChatGPT/Codex subscription. The
   * subscription /responses endpoint exposes no live /models list, but the Codex
   * CLI writes the available models to `models_cache.json` next to the auth file
   * (e.g. `~/.codex/models_cache.json`). We read the cached `slug` values so the
   * model catalog/picker can offer the full Codex set instead of just the one
   * configured model. Any failure (missing/unparseable/empty) degrades to
   * `[this.model]` and never throws — this is a best-effort local read.
   */
  private listChatGptSubscriptionModels(): string[] {
    const fallback = [this.model];
    try {
      const authConfig = this.getChatGptSubscriptionAuth();
      const authFile = expandHomePath(
        authConfig.authFile ?? OPENAI_CHATGPT_AUTH_DEFAULT_FILE,
        process.env,
      );
      const cacheFile = join(dirname(authFile), "models_cache.json");
      const parsed = JSON.parse(readFileSync(cacheFile, "utf8")) as {
        models?: Array<{ slug?: unknown }>;
      };
      const slugs = (parsed.models ?? [])
        .map((entry) => entry?.slug)
        .filter((slug): slug is string => typeof slug === "string" && slug.length > 0);
      if (slugs.length === 0) return fallback;
      // Ensure the configured model is present, then dedupe (preserving order).
      return Array.from(new Set([this.model, ...slugs]));
    } catch {
      return fallback;
    }
  }

  /**
   * Fetch with exponential backoff retry for transient errors (429, 5xx).
   *
   * `hooks.onBackoff` (when supplied by the FallbackChain via the call options) is
   * forwarded so a deliberate 429 retry backoff resets the chain's first-response
   * timer and is classified as rate-limiting, not an unresponsive endpoint.
   */
  protected async fetchWithRetry(
    url: string,
    options: RequestInit,
    hooks?: ProviderCallHooks,
  ): Promise<Response> {
    return sharedFetchWithRetry(url, options, {
      maxRetries: MAX_RETRIES,
      callerName: this.name,
      onBackoff: hooks?.onBackoff,
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
    const cachedPromptTokens = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;

    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0),
        ...(cachedPromptTokens > 0 ? { cacheReadInputTokens: cachedPromptTokens } : {}),
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

  private async resolveChatGptAuth(): Promise<ResolvedChatGptAuth> {
    const authConfig = this.getChatGptSubscriptionAuth();

    // ensureOpenAiSubscriptionAuth transparently refreshes an expired access token
    // via the stored refresh_token before failing, so a stale session is renewed
    // without forcing the user back through sign-in.
    const inspection = await ensureOpenAiSubscriptionAuth(
      authConfig.accessToken && authConfig.accountId
        ? {
            accessToken: authConfig.accessToken,
            accountId: authConfig.accountId,
            authFile: authConfig.authFile,
            env: process.env,
          }
        : {
            authFile: authConfig.authFile ?? OPENAI_CHATGPT_AUTH_DEFAULT_FILE,
            env: process.env,
          },
    );
    if (!inspection.ok || !inspection.accessToken || !inspection.accountId) {
      throw new Error(`${this.name} ${inspection.detail}`);
    }
    return {
      accessToken: inspection.accessToken,
      accountId: inspection.accountId,
    };
  }

  /**
   * Force-refresh the ChatGPT/Codex subscription access token via the stored
   * refresh_token. Used after a live 401/403 from a server-invalidated token
   * whose local JWT has not yet expired (the expiry-driven refresh in
   * ensureOpenAiSubscriptionAuth does not cover that case). The refresh primitive
   * writes the new token to the auth file, so a subsequent buildHeaders() picks it
   * up. Returns true when a refresh succeeded so the caller can retry once.
   */
  private async tryRefreshChatGptToken(): Promise<boolean> {
    if (!this.isChatGptSubscriptionMode()) return false;
    const authConfig = this.getChatGptSubscriptionAuth();
    // Refresh only works against the file-based refresh_token; an explicit
    // in-memory access token has nothing to refresh against.
    if (authConfig.accessToken) return false;
    try {
      const result = await refreshOpenAiSubscriptionToken({
        authFile: authConfig.authFile ?? OPENAI_CHATGPT_AUTH_DEFAULT_FILE,
        env: process.env,
      });
      if (result.ok) {
        getLoggerSafe().info(`${this.name} subscription token refreshed after a 401; retrying once`);
        return true;
      }
      getLoggerSafe().warn(`${this.name} subscription token refresh failed: ${result.error ?? "unknown error"}`);
      return false;
    } catch (err) {
      getLoggerSafe().warn(`${this.name} subscription token refresh threw`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private buildChatGptResponsesRequest(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    responseSchema?: ResponseSchema,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      // Always the pinned Codex-supported model (NOT a churned per-call override).
      model: this.chatGptModel,
      instructions: systemPrompt,
      input: this.buildChatGptInput(messages),
      // Request a reasoning summary so gpt-5.x reasoning models stream
      // `response.reasoning_summary_text.delta` events during the otherwise-silent
      // think phase. This gives a dense liveness heartbeat (handled in processFrame)
      // on top of the ~30s `keepalive`, and surfaces the model's thinking. `summary`
      // only (no `effort`) keeps the model's default reasoning depth unchanged.
      reasoning: { summary: "auto" },
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

    if (responseSchema) {
      // The Responses API spells structured output as `text.format`, not the
      // chat-completions `response_format`. Same constrained decoding, different
      // envelope — sending the chat shape here is silently ignored.
      body["text"] = {
        format: {
          type: "json_schema",
          name: responseSchema.name,
          schema: responseSchema.schema,
          strict: true,
        },
      };
    }

    return body;
  }

  /**
   * Turns a failed ChatGPT/Codex /responses probe into an accurate, actionable
   * reason. The Codex backend rejects non-Codex models with HTTP 400 and a body
   * like {"detail":"The 'gpt-4.1-mini' model is not supported when using Codex
   * with a ChatGPT account."} — so a model mismatch must NOT be reported as an
   * auth failure ("sign in again").
   */
  private async describeChatGptHealthFailure(response: Response): Promise<string> {
    let backendDetail = "";
    try {
      const text = await response.text();
      try {
        const parsed = JSON.parse(text) as { detail?: unknown; error?: { message?: unknown } };
        if (typeof parsed.detail === "string") {
          backendDetail = parsed.detail;
        } else if (parsed.error && typeof parsed.error.message === "string") {
          backendDetail = parsed.error.message;
        }
      } catch {
        backendDetail = text.slice(0, 200).trim();
      }
    } catch {
      // ignore body read errors — status code still informs the message
    }

    if (response.status === 401 || response.status === 403) {
      return `ChatGPT/Codex subscription was rejected (HTTP ${response.status}). This most likely means the codex token needs refreshing — re-run \`codex login\` to renew it — or that the codex wire protocol changed (the client-identity headers Strada sends to match the codex CLI may be out of date). API-key mode remains a stable alternative if the subscription path keeps failing.${backendDetail ? ` ${backendDetail}` : ""}`;
    }
    if (response.status === 400 || response.status === 404) {
      return codexModelRejectionMessage(this.chatGptModel, {
        status: response.status,
        backendDetail: backendDetail || undefined,
      });
    }
    return `ChatGPT/Codex subscription health probe failed (HTTP ${response.status}).${backendDetail ? ` ${backendDetail}` : ""}`;
  }

  /**
   * Rewrite a raw subscription `/responses` transport error into a clear, actionable
   * message WHEN it is a Codex model-rejection (HTTP 400 "...model is not supported
   * when using Codex with a ChatGPT account."). fetchWithRetry surfaces that as a
   * terse `"<name> API error 400: {...}"`, which (a) buries the fix and (b) would be
   * read by the FallbackChain as a transient/fail-over-able model error. The rewritten
   * message names the pinned model, points at a Codex-supported model and the API-key
   * alternative, and carries the distinct "not accepted by the ChatGPT/Codex
   * subscription endpoint" phrase the chain recognises as a non-retryable config error
   * (so the provider's health is not churned). Any other error is returned untouched.
   */
  private rewriteChatGptModelRejection(err: unknown): Error {
    const base = err instanceof Error ? err : new Error(String(err));
    const msg = base.message;
    if (!isRawCodexModelRejection(msg)) {
      return base;
    }
    return new Error(
      `${this.name} ${codexModelRejectionMessage(this.chatGptModel, { backendDetail: msg })}`,
      { cause: base },
    );
  }

  private buildChatGptHealthCheckRequest(): Record<string, unknown> {
    return {
      // Probe the SAME pinned model the live `/responses` calls will use, so a
      // healthy boot guarantees the model the chat path sends is Codex-supported.
      model: this.chatGptModel,
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
    /** OpenAI caches prompt prefixes automatically; this is the cached share
     *  of prompt_tokens (not an addition to it). */
    prompt_tokens_details?: { cached_tokens?: number };
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
    prompt_tokens_details?: { cached_tokens?: number };
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
      input_tokens_details?: { cached_tokens?: number };
    };
    output?: ChatGptOutputItem[];
  };
}
