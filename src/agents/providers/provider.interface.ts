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
    // still records failure + falls over (audit #6).
    options?: { signal?: AbortSignal; externalSignal?: AbortSignal },
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
    // See `chat` — `externalSignal` is the task/control-plane abort signal (audit #6).
    options?: { signal?: AbortSignal; externalSignal?: AbortSignal },
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
