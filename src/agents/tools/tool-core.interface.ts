/**
 * Core Tool Interfaces - Enhanced
 * 
 * Rich tool interface with metadata and lifecycle hooks.
 */

// ============================================================================
// Tool Context
// ============================================================================

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
  /** User ID for the current session */
  userId?: string;
  /** Chat ID for the current session */
  chatId?: string;
  /** Session ID for tracking */
  sessionId?: string;
}

// ============================================================================
// Tool Result
// ============================================================================

/**
 * Result returned by a tool execution.
 */
export interface ToolExecutionResult {
  /** The output content to return to the LLM */
  content: string;
  /** Whether this result represents an error */
  isError?: boolean;
  /** Optional metadata for logging/debugging */
  metadata?: ToolResultMetadata;
}

/**
 * Metadata for tool execution results.
 */
export interface ToolResultMetadata {
  /** Execution time in milliseconds */
  executionTimeMs?: number;
  /** Number of items affected (files, lines, etc.) */
  itemsAffected?: number;
  /** File paths affected */
  filesAffected?: string[];
  /** Additional custom data */
  [key: string]: unknown;
}

// ============================================================================
// Tool Schema
// ============================================================================

/**
 * JSON Schema property definition.
 */
export interface ToolSchemaProperty {
  type: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  items?: ToolSchemaProperty;
  properties?: Record<string, ToolSchemaProperty>;
  required?: string[];
}

/**
 * Tool input schema.
 */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, ToolSchemaProperty>;
  required?: string[];
}

// ============================================================================
// Tool Metadata
// ============================================================================

/**
 * Tool category classification.
 */
export type ToolCategory =
  | "file"
  | "code"
  | "search"
  | "strada"
  | "shell"
  | "git"
  | "dotnet"
  | "memory"
  | "browser"
  | "composite"
  | "introspection"
  | "custom";

/**
 * Tool risk level.
 */
export type ToolRiskLevel = "safe" | "caution" | "dangerous";

/**
 * Tool metadata for registration and UI.
 */
export interface ToolMetadata {
  /** Unique tool name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Tool category */
  category: ToolCategory;
  /** Risk level */
  riskLevel: ToolRiskLevel;
  /** Whether the tool modifies state */
  isReadOnly: boolean;
  /** Whether confirmation is required */
  requiresConfirmation: boolean;
  /** Example usage */
  examples?: ToolExample[];
  /** Tool version */
  version?: string;
  /** Tool author */
  author?: string;
  /** Dependencies on other tools */
  dependencies?: string[];
  /** Tags for filtering */
  tags?: string[];
}

/**
 * Example usage for a tool.
 */
export interface ToolExample {
  /** Example description */
  description: string;
  /** Example input */
  input: Record<string, unknown>;
  /** Expected output (optional) */
  output?: string;
}

// ============================================================================
// Tool Lifecycle
// ============================================================================

/**
 * Interface for tools that need initialization.
 */
export interface IInitializableTool {
  /** Initialize the tool */
  initialize(): Promise<void>;
  /** Check if tool is initialized */
  isInitialized(): boolean;
}

/**
 * Interface for tools that need cleanup.
 */
export interface IDisposableTool {
  /** Dispose of resources */
  dispose(): Promise<void>;
  /** Check if tool is disposed */
  isDisposed(): boolean;
}

/**
 * Interface for tools that can validate their input.
 */
export interface IValidatableTool {
  /** Validate input without executing */
  validate(input: Record<string, unknown>): ValidationResult;
}

/**
 * Validation result.
 */
export interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
}

export interface ValidationError {
  field: string;
  message: string;
}

// ============================================================================
// Tool Events
// ============================================================================

/**
 * Tool execution event.
 */
export interface ToolExecutionEvent {
  toolName: string;
  input: Record<string, unknown>;
  context: ToolContext;
  startTime: Date;
  endTime?: Date;
  result?: ToolExecutionResult;
}

/**
 * Tool event listener.
 */
export type ToolEventListener = (event: ToolExecutionEvent) => void;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a tool is initializable.
 */
export function isInitializableTool(tool: unknown): tool is IInitializableTool {
  return (
    typeof (tool as IInitializableTool).initialize === "function" &&
    typeof (tool as IInitializableTool).isInitialized === "function"
  );
}

/**
 * Check if a tool is disposable.
 */
export function isDisposableTool(tool: unknown): tool is IDisposableTool {
  return (
    typeof (tool as IDisposableTool).dispose === "function" &&
    typeof (tool as IDisposableTool).isDisposed === "function"
  );
}

/**
 * Check if a tool is validatable.
 */
export function isValidatableTool(tool: unknown): tool is IValidatableTool {
  return typeof (tool as IValidatableTool).validate === "function";
}
