/**
 * AI Provider Interface
 *
 * Common interface for AI providers (Claude, OpenAI, Ollama).
 * For streaming support, check capabilities or use IStreamingProvider.
 */

import type {
  ToolDefinition,
  ConversationMessage,
  ProviderResponse,
  StreamCallback,
  StructuredStreamCallback,
  ProviderCapabilities,
} from "./provider-core.interface.js";
import type { BackoffInfo } from "../../common/fetch-with-retry.js";

/**
 * Optional control-plane hooks the FallbackChain passes down through a provider call.
 *
 * `onBackoff` fires when a provider's own HTTP retry wrapper is about to wait ON
 * PURPOSE during a deliberate retry backoff (e.g. a 429 with maxRetries). The chain
 * uses it to (1) reset its first-response silence timer — a deliberate backoff must
 * not be counted against the "unresponsive endpoint" budget — and (2) remember that
 * the failure cause was rate-limiting (HTTP 429) so a later timeout/exhaustion is
 * reported honestly as rate-limited, not as an unresponsive endpoint. For a 429 the
 * info also carries parsed rate-limit headers + a truncated body (never auth/secrets)
 * so a consumer can classify/surface WHY the 429 happened. Optional and back-compat:
 * providers without an HTTP retry wrapper simply never call it.
 */
export interface ProviderCallHooks {
  onBackoff?: (info: BackoffInfo) => void;
}

/**
 * Options every provider `chat`/`chatStream` accepts. `signal` aborts the underlying
 * request (and may carry the per-call stall watchdog); `externalSignal` is the
 * task/control-plane abort (audit #6); `hooks` carries optional resilience callbacks.
 */
export interface ProviderCallOptions extends ProviderCallHooks {
  signal?: AbortSignal;
  externalSignal?: AbortSignal;
}

/**
 * Core AI provider interface.
 * All providers must implement this.
 */
export interface IAIProvider {
  /** Provider name for logging */
  readonly name: string;

  /** Provider capabilities */
  readonly capabilities: ProviderCapabilities;

  /** Send a message with tools and get a response */
  chat(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    // `signal` aborts the underlying request — it may also carry the per-call streaming
    // stall watchdog. `externalSignal` is the TASK / CONTROL-PLANE abort signal (user
    // cancel and/or task-inactivity wind-down — i.e. "stop this task", NOT "this provider
    // stalled"). FallbackChainProvider treats an aborted externalSignal as a benign cancel:
    // it does NOT poison provider health and does NOT fall over, so a cancel is never
    // mistaken for an outage. A genuine provider stall surfaces via `signal` only and
    // still records failure + falls over (audit #6). `onBackoff` is an optional
    // resilience hook (see ProviderCallHooks).
    options?: ProviderCallOptions,
  ): Promise<ProviderResponse>;

  /** Optional health check to verify API connectivity on startup */
  healthCheck?(): Promise<boolean>;

  /** Optional method to list available models from the provider's API */
  listModels?(): Promise<string[]>;
}

/**
 * Extended interface for providers that support streaming.
 */
export interface IStreamingProvider extends IAIProvider {
  /** Send a message and stream text chunks back via callback. */
  chatStream(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    onChunk: StreamCallback,
    // See `chat` — `externalSignal` is the task/control-plane abort signal (audit #6);
    // `onBackoff` is an optional resilience hook (see ProviderCallHooks).
    options?: ProviderCallOptions,
  ): Promise<ProviderResponse>;
}

/**
 * Extended interface for providers that support structured streaming.
 */
export interface IStructuredStreamingProvider extends IAIProvider {
  /** Send a message and stream structured chunks back. */
  chatStreamStructured(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    onChunk: StructuredStreamCallback,
  ): Promise<ProviderResponse>;
}

/**
 * Type guard for streaming support.
 */
export function supportsStreaming(provider: IAIProvider): provider is IStreamingProvider {
  return (
    provider.capabilities.streaming &&
    typeof (provider as IStreamingProvider).chatStream === "function"
  );
}

/**
 * Issue a single-user-message, tool-less LLM call over the STREAMING path when the
 * provider supports it, falling back to the blocking {@link IAIProvider.chat} otherwise.
 *
 * Streaming matters for SLOW reasoning models behind the FallbackChain: a blocking
 * `chat()` never reports activity, so the chain's first-response timer degenerates into
 * a whole-call deadline and aborts with "sent no response within Nms" before a long,
 * silent think completes. `chatStream` fires the chain's `markActivity` on the first
 * SSE chunk → the timer clears → a slow reasoning stream is allowed to COMPLETE.
 *
 * The streamed chunks are accumulated only as a defensive fallback: providers set
 * `response.text` to the full body, which is what we return — identical to the
 * non-streaming path. If a provider returns empty text but streamed chunks, we
 * reconstruct the text from the accumulator so downstream parsing still succeeds.
 */
export async function streamOrChatText(
  provider: IAIProvider,
  systemPrompt: string,
  userMessage: string,
): Promise<{ text: string }> {
  const messages: ConversationMessage[] = [{ role: "user", content: userMessage }];
  if (supportsStreaming(provider)) {
    let accumulated = "";
    const response = await provider.chatStream(systemPrompt, messages, [], (chunk) => {
      // The first chunk clears the FallbackChain first-response timer (see fallback-chain.ts).
      if (chunk) accumulated += chunk;
    });
    const text = response.text && response.text.length > 0 ? response.text : accumulated;
    return { text };
  }
  return provider.chat(systemPrompt, messages, []);
}

/**
 * Type guard for structured streaming support.
 */
export function supportsStructuredStreaming(
  provider: IAIProvider,
): provider is IStructuredStreamingProvider {
  return typeof (provider as IStructuredStreamingProvider).chatStreamStructured === "function";
}

// Re-export all types
export type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ConversationMessage,
  TokenUsage,
  ProviderResponse,
  StopReason,
  StreamChunk,
  StreamCallback,
  StructuredStreamCallback,
  ProviderCapabilities,
  ProviderConfig,
} from "./provider-core.interface.js";
