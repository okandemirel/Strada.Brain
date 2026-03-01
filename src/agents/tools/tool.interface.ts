/**
 * Context provided to every tool execution.
 */
export interface ToolContext {
  /** Absolute path to the Unity project root */
  projectPath: string;
  /** Current working directory (may differ from projectPath) */
  workingDirectory: string;
  /** Whether the system is in read-only mode */
  readOnly: boolean;
}

/**
 * Result returned by a tool execution.
 */
export interface ToolExecutionResult {
  /** The output content to return to the LLM */
  content: string;
  /** Whether this result represents an error */
  isError?: boolean;
  /** Optional metadata for logging/debugging */
  metadata?: Record<string, unknown>;
}

/**
 * Base interface for all tools.
 * Each tool provides a name, description, JSON schema for input,
 * and an execute function.
 */
export interface ITool {
  /** Unique tool name (used in function calling) */
  readonly name: string;
  /** Human-readable description of what this tool does */
  readonly description: string;
  /** JSON Schema for the tool's input parameters */
  readonly inputSchema: Record<string, unknown>;
  /** Execute the tool with validated input */
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult>;
}
