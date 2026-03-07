/**
 * CompositeTool -- ITool implementation for sequential chain execution
 *
 * Executes a chain of tools sequentially, passing output from each step
 * to the next via parameter mappings.
 */

import type { ITool, ToolContext, ToolExecutionResult } from "../../agents/tools/tool.interface.js";
import type { ToolRegistry } from "../../core/tool-registry.js";
import type { IEventEmitter, LearningEventMap } from "../../core/event-bus.js";
import type { ChainMetadata } from "./chain-types.js";

export interface CompositeToolMetadata {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  chainMetadata: ChainMetadata;
}

export class CompositeTool implements ITool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;

  constructor(
    _metadata: CompositeToolMetadata,
    private readonly toolRegistry: ToolRegistry,
    private readonly eventBus: IEventEmitter<LearningEventMap>,
  ) {
    this.name = _metadata.name;
    this.description = _metadata.description;
    this.inputSchema = _metadata.inputSchema;
  }

  async execute(_input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    // Stub -- will be implemented in GREEN phase
    return { content: "Not implemented", isError: true };
  }
}
