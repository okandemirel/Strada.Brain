/**
 * Tool definition compatible with Claude/OpenAI function calling.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * A tool call requested by the LLM.
 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Result of executing a tool.
 */
export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

/**
 * A message in the conversation.
 */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

/**
 * Response from the AI provider.
 */
export interface ProviderResponse {
  /** Text content from the assistant */
  text: string;
  /** Tool calls the assistant wants to make */
  toolCalls: ToolCall[];
  /** Whether the assistant wants to stop (no more tool calls) */
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  /** Token usage for monitoring */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Callback for streaming text chunks from the provider.
 */
export type StreamCallback = (chunk: string) => void;

/**
 * Common interface for AI providers (Claude, OpenAI, Ollama).
 */
export interface IAIProvider {
  /** Provider name for logging */
  readonly name: string;

  /** Send a message with tools and get a response */
  chat(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[]
  ): Promise<ProviderResponse>;

  /** Send a message and stream text chunks back via callback. Falls back to non-streaming. */
  chatStream?(
    systemPrompt: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    onChunk: StreamCallback
  ): Promise<ProviderResponse>;
}
