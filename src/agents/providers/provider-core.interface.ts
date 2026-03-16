/**
 * Core Provider Types - Type-safe definitions
 * 
 * Base types for AI provider communication with:
 * - Discriminated unions for message types
 * - Branded types for IDs
 * - Strict typing for tool calls
 */

import type {
  JsonObject,
} from "../../types/index.js";

// =============================================================================
// BASE MESSAGE TYPES
// =============================================================================

/** Message content types */
export type MessageContent = 
  | { type: "text"; text: string }
  | { type: "image"; source: ImageSource }
  | { type: "tool_use"; id: string; name: string; input: JsonObject }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

/** Image source for vision models */
export type ImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };

/** Base conversation message */
interface BaseConversationMessage {
  readonly role: "user" | "assistant";
}

/** User message */
export interface UserMessage extends BaseConversationMessage {
  readonly role: "user";
  readonly content: string | MessageContent[];
}

/** Assistant message */
export interface AssistantMessage extends BaseConversationMessage {
  readonly role: "assistant";
  readonly content: string;
  readonly tool_calls?: ToolCall[];
  readonly stop_reason?: StopReason;
}

/** Conversation message union */
export type ConversationMessage = UserMessage | AssistantMessage;

// =============================================================================
// TOOL TYPES
// =============================================================================

/** Tool definition for function calling */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JsonObject; // JSON Schema
}

/** Tool call from assistant */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
  readonly providerMetadata?: Record<string, unknown>;
}

/** Tool execution result */
export interface ToolResult {
  readonly toolCallId: string;
  readonly content: string;
  readonly isError?: boolean;
}

// =============================================================================
// PROVIDER RESPONSE TYPES
// =============================================================================

/** Stop/finish reasons */
export type StopReason = 
  | "end_turn" 
  | "max_tokens" 
  | "stop_sequence" 
  | "tool_use";

/** Token usage statistics */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
}

/** Provider response */
export interface ProviderResponse {
  readonly text: string;
  readonly toolCalls: ToolCall[];
  readonly stopReason: StopReason;
  readonly usage: TokenUsage;
}

// =============================================================================
// STREAMING TYPES
// =============================================================================

/** Stream chunk types */
export type StreamChunkType = 
  | "text"
  | "tool_use"
  | "tool_input"
  | "stop"
  | "error";

/** Base stream chunk */
interface BaseStreamChunk {
  readonly type: StreamChunkType;
}

/** Text chunk */
export interface TextStreamChunk extends BaseStreamChunk {
  readonly type: "text";
  readonly text: string;
}

/** Tool use start chunk */
export interface ToolUseStartChunk extends BaseStreamChunk {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
}

/** Tool input chunk */
export interface ToolInputChunk extends BaseStreamChunk {
  readonly type: "tool_input";
  readonly id: string;
  readonly partialInput: string;
}

/** Stop chunk */
export interface StopStreamChunk extends BaseStreamChunk {
  readonly type: "stop";
  readonly stopReason: StopReason;
}

/** Error chunk */
export interface ErrorStreamChunk extends BaseStreamChunk {
  readonly type: "error";
  readonly error: Error;
  readonly recoverable: boolean;
}

/** Stream chunk union */
export type StreamChunk =
  | TextStreamChunk
  | ToolUseStartChunk
  | ToolInputChunk
  | StopStreamChunk
  | ErrorStreamChunk;

/** Simple stream callback (legacy) */
export type StreamCallback = (chunk: string) => void;

/** Structured stream callback */
export type StructuredStreamCallback = (chunk: StreamChunk) => void;

// =============================================================================
// CAPABILITIES & CONFIG
// =============================================================================

/** Provider capabilities */
export interface ProviderCapabilities {
  readonly maxTokens: number;
  readonly streaming: boolean;
  readonly structuredStreaming: boolean;
  readonly toolCalling: boolean;
  readonly vision: boolean;
  readonly systemPrompt: boolean;
  readonly contextWindow?: number;
  readonly thinkingSupported?: boolean;
  readonly specialFeatures?: string[];
}

/** Provider configuration */
export interface ProviderConfig {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

// =============================================================================
// TYPE GUARDS
// =============================================================================

/** Check if message is from user */
export function isUserMessage(msg: ConversationMessage): msg is UserMessage {
  return msg.role === "user";
}

/** Check if message is from assistant */
export function isAssistantMessage(msg: ConversationMessage): msg is AssistantMessage {
  return msg.role === "assistant";
}

/** Check if assistant message has tool calls */
export function hasToolCalls(msg: AssistantMessage): boolean {
  return msg.tool_calls !== undefined && msg.tool_calls.length > 0;
}

/** Check if stream chunk is text */
export function isTextChunk(chunk: StreamChunk): chunk is TextStreamChunk {
  return chunk.type === "text";
}

/** Check if stream chunk is tool use */
export function isToolUseChunk(chunk: StreamChunk): chunk is ToolUseStartChunk {
  return chunk.type === "tool_use";
}

/** Check if response has tool calls */
export function responseHasTools(response: ProviderResponse): boolean {
  return response.toolCalls.length > 0;
}

/** Check if stop reason indicates tool use */
export function stoppedForTools(reason: StopReason): boolean {
  return reason === "tool_use";
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Create a text-only user message
 */
export function createTextMessage(content: string): UserMessage {
  return { role: "user", content };
}

/**
 * Create an assistant response message
 */
export function createAssistantMessage(
  content: string,
  options?: { tool_calls?: ToolCall[]; stop_reason?: StopReason }
): AssistantMessage {
  return {
    role: "assistant",
    content,
    tool_calls: options?.tool_calls,
    stop_reason: options?.stop_reason,
  };
}

/**
 * Create a tool definition
 */
export function createToolDefinition(
  name: string,
  description: string,
  inputSchema: JsonObject
): ToolDefinition {
  return { name, description, input_schema: inputSchema };
}

/**
 * Create a tool call
 */
export function createToolCall(
  id: string,
  name: string,
  input: JsonObject,
  providerMetadata?: Record<string, unknown>,
): ToolCall {
  return providerMetadata ? { id, name, input, providerMetadata } : { id, name, input };
}

/**
 * Create a provider response
 */
export function createProviderResponse(
  text: string,
  options?: {
    toolCalls?: ToolCall[];
    stopReason?: StopReason;
    usage?: Partial<TokenUsage>;
  }
): ProviderResponse {
  const toolCalls = options?.toolCalls ?? [];
  const usage = options?.usage ?? {};
  
  return {
    text,
    toolCalls,
    stopReason: options?.stopReason ?? (toolCalls.length > 0 ? "tool_use" : "end_turn"),
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
    },
  };
}

/**
 * Calculate cost estimate (approximate)
 */
export function estimateCost(
  usage: TokenUsage,
  inputPricePer1M: number,
  outputPricePer1M: number
): number {
  return (
    (usage.inputTokens / 1_000_000) * inputPricePer1M +
    (usage.outputTokens / 1_000_000) * outputPricePer1M
  );
}
