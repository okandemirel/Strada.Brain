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

/**
 * The copy a loader registers, under its namespaced name, for a tool Strada did
 * not write (plugin, skill).
 *
 * This was a bare spread, which keeps only own enumerable properties: a class
 * tool declaring its metadata through getMetadata() or a `get metadata()`
 * accessor — both on the prototype — reached classification with no
 * declaration, and a writer whose name and shape look harmless (set_color
 * {objectName, value}) was registered read-only and ran with no confirmation.
 * The declaration is read from the original, where its `this` and private
 * fields work, and pinned on the copy. One that throws is unknown, not absent:
 * the name heuristic for undeclared tools could call it read-only, so it is
 * recorded as a writer that asks first.
 */
export function namespaceRuntimeTool(tool: ITool, name: string): ITool {
  let metadata: ToolMetadata | undefined;
  try {
    metadata = getToolMetadata(tool);
  } catch {
    metadata = {
      name,
      description: tool.description,
      category: "custom",
      riskLevel: "dangerous",
      isReadOnly: false,
      requiresConfirmation: true,
    };
  }
  return {
    ...tool,
    name,
    execute: tool.execute.bind(tool),
    isPlugin: true,
    ...(metadata ? { metadata } : {}),
  };
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
