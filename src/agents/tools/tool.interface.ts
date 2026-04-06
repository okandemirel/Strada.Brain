/**
 * Tool Interface
 * 
 * Base interface for all tools. Each tool provides a name, description,
 * JSON schema for input, and an execute function.
 * 
 * Enhanced with metadata and lifecycle hooks from tool-core.interface.ts.
 */

import type {
  IToolBase,
  ToolMetadata,
  ToolCategory,
  ToolRiskLevel,
} from "./tool-core.interface.js";

/**
 * Base interface for all tools.
 * Extends IToolBase (defined in tool-core.interface.ts) with optional metadata.
 */
export interface ITool extends IToolBase {
  /**
   * Whether this tool is loaded from a plugin (optional).
   * @default false
   */
  isPlugin?: boolean;

  /**
   * Tool metadata for registration and UI (optional).
   * Can be provided as a property or via getMetadata() method.
   */
  metadata?: ToolMetadata;

  /**
   * Get tool metadata (alternative to metadata property).
   */
  getMetadata?(): ToolMetadata;
}

/**
 * Extended tool interface with full metadata support.
 */
export interface IEnhancedTool extends ITool {
  /** Full tool metadata */
  readonly metadata: ToolMetadata;
  
  /** Tool category */
  readonly category: ToolCategory;
  
  /** Risk level */
  readonly riskLevel: ToolRiskLevel;
  
  /** Whether tool is read-only */
  readonly isReadOnly: boolean;
  
  /** Whether confirmation is required */
  readonly requiresConfirmation: boolean;
}

/**
 * Type guard for enhanced tools.
 */
export function isEnhancedTool(tool: ITool): tool is IEnhancedTool {
  return "metadata" in tool || typeof tool.getMetadata === "function";
}

/**
 * Get metadata from a tool (handles both property and method).
 */
export function getToolMetadata(tool: ITool): ToolMetadata | undefined {
  if (tool.metadata) {
    return tool.metadata;
  }
  if (typeof tool.getMetadata === "function") {
    return tool.getMetadata();
  }
  return undefined;
}

// Re-export all types
export type {
  IToolBase,
  ToolContext,
  ToolExecutionResult,
  ToolInputSchema,
  ToolMetadata,
  ToolCategory,
  ToolRiskLevel,
  ToolExample,
  ToolResultMetadata,
  ValidationResult,
  ValidationError,
  ToolExecutionEvent,
  ToolEventListener,
  IInitializableTool,
  IDisposableTool,
  IValidatableTool,
} from "./tool-core.interface.js";

export {
  isInitializableTool,
  isDisposableTool,
  isValidatableTool,
} from "./tool-core.interface.js";
