/**
 * CompositeTool -- ITool implementation for sequential chain execution
 *
 * Executes a chain of tools sequentially, passing output from each step
 * to the next via parameter mappings. Validates tool existence at execution
 * time (TOOL-05) and emits chain:executed events.
 */

import type {
  ITool,
  ToolContext,
  ToolExecutionResult,
} from "../../agents/tools/tool.interface.js";
import type { ToolRegistry } from "../../core/tool-registry.js";
import type {
  IEventEmitter,
  LearningEventMap,
  ChainExecutionEvent,
} from "../../core/event-bus.js";
import type { ChainMetadata } from "./chain-types.js";

export interface CompositeToolMetadata {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  chainMetadata: ChainMetadata;
}

interface StepRecord {
  tool: string;
  success: boolean;
  durationMs: number;
}

export class CompositeTool implements ITool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  private readonly chainMetadata: ChainMetadata;

  constructor(
    metadata: CompositeToolMetadata,
    private readonly toolRegistry: ToolRegistry,
    private readonly eventBus: IEventEmitter<LearningEventMap>,
  ) {
    this.name = metadata.name;
    this.description = metadata.description;
    this.inputSchema = metadata.inputSchema;
    this.chainMetadata = metadata.chainMetadata;
  }

  /** Get the ordered tool sequence for this chain */
  get toolSequence(): string[] {
    return this.chainMetadata.toolSequence;
  }

  /** Check if this composite tool contains the given tool in its chain */
  containsTool(name: string): boolean {
    return this.chainMetadata.toolSequence.includes(name);
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const stepResults: StepRecord[] = [];

    // TOOL-05: Execution-time validation -- ensure all tools still exist
    for (const toolName of this.chainMetadata.toolSequence) {
      if (!this.toolRegistry.has(toolName)) {
        this.emitChainEvent(false, stepResults, startTime);
        return {
          content: `Chain '${this.name}' failed: tool '${toolName}' no longer exists`,
          isError: true,
        };
      }
    }

    // Execute chain steps sequentially
    let previousOutput: Record<string, unknown> = {};
    const stepOutputs: Array<{ tool: string; output: string }> = [];

    for (let i = 0; i < this.chainMetadata.toolSequence.length; i++) {
      const toolName = this.chainMetadata.toolSequence[i]!;
      const stepInput = this.buildStepInput(i, input, previousOutput);
      const stepStart = Date.now();

      const result = await this.toolRegistry.execute(
        toolName,
        stepInput,
        context,
      );

      const stepDuration = Date.now() - stepStart;
      const success = !result.isError;

      stepResults.push({
        tool: toolName,
        success,
        durationMs: stepDuration,
      });

      if (result.isError) {
        // Fail immediately on step error
        this.emitChainEvent(false, stepResults, startTime);
        return {
          content: `Chain '${this.name}' failed at step ${i + 1} (${toolName}): ${result.content}`,
          isError: true,
        };
      }

      stepOutputs.push({ tool: toolName, output: result.content });
      previousOutput = this.parseStepOutput(result.content);
    }

    // Success -- emit event and return combined output
    this.emitChainEvent(true, stepResults, startTime);

    const summary = stepOutputs
      .map((s, i) => `Step ${i + 1} [${s.tool}]: ${s.output}`)
      .join("\n");

    return { content: summary };
  }

  /**
   * Build input for a specific step by applying parameter mappings.
   */
  private buildStepInput(
    stepIndex: number,
    userInput: Record<string, unknown>,
    previousOutput: Record<string, unknown>,
  ): Record<string, unknown> {
    const stepInput: Record<string, unknown> = {};

    for (const mapping of this.chainMetadata.parameterMappings) {
      if (mapping.stepIndex !== stepIndex) continue;

      switch (mapping.source) {
        case "userInput":
          if (mapping.sourceKey && mapping.sourceKey in userInput) {
            stepInput[mapping.parameterName] = userInput[mapping.sourceKey];
          } else if (mapping.defaultValue !== undefined) {
            stepInput[mapping.parameterName] = mapping.defaultValue;
          }
          break;

        case "previousOutput":
          if (mapping.sourceKey && mapping.sourceKey in previousOutput) {
            stepInput[mapping.parameterName] =
              previousOutput[mapping.sourceKey];
          } else if (mapping.defaultValue !== undefined) {
            stepInput[mapping.parameterName] = mapping.defaultValue;
          }
          break;

        case "constant":
          stepInput[mapping.parameterName] =
            mapping.defaultValue !== undefined
              ? mapping.defaultValue
              : mapping.sourceKey;
          break;
      }
    }

    return stepInput;
  }

  /**
   * Parse step output into a record for the next step's parameter mapping.
   * Tries JSON.parse first; falls back to { result: content }.
   */
  private parseStepOutput(content: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
      return { result: content };
    } catch {
      return { result: content };
    }
  }

  /**
   * Emit the chain:executed event.
   */
  private emitChainEvent(
    success: boolean,
    stepResults: StepRecord[],
    startTime: number,
  ): void {
    const event: ChainExecutionEvent = {
      chainName: this.name,
      success,
      stepResults,
      totalDurationMs: Date.now() - startTime,
      timestamp: Date.now(),
    };
    this.eventBus.emit("chain:executed", event);
  }
}
