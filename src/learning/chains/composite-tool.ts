/**
 * CompositeTool -- ITool implementation for chain execution (V1 sequential + V2 DAG parallel)
 *
 * V1: Executes a chain of tools sequentially, passing output from each step
 *     to the next via parameter mappings.
 * V2: Executes a chain of tools via DAG wave-based parallel execution with
 *     saga rollback on failure (or forward-recovery for non-reversible chains).
 *
 * Validates tool existence at execution time (TOOL-05) and emits chain:executed events.
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
import type {
  ChainMetadata,
  ChainMetadataV2,
  ChainResilienceConfig,
  ChainStepNode,
  RollbackReport,
} from "./chain-types.js";
import { DEFAULT_RESILIENCE_CONFIG } from "./chain-types.js";
import { computeChainWaves } from "./chain-dag.js";
import { executeRollback } from "./chain-rollback.js";
import { sanitizeSecrets } from "../../security/secret-sanitizer.js";

// =============================================================================
// TYPES
// =============================================================================

export interface CompositeToolMetadata {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  chainMetadata: ChainMetadata | ChainMetadataV2;
  resilienceConfig?: ChainResilienceConfig;
}

interface StepRecord {
  stepId: string;
  tool: string;
  success: boolean;
  durationMs: number;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class CompositeTool implements ITool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  private readonly chainMetadata: ChainMetadata | ChainMetadataV2;
  private readonly resilienceConfig: ChainResilienceConfig;

  constructor(
    metadata: CompositeToolMetadata,
    private readonly toolRegistry: ToolRegistry,
    private readonly eventBus: IEventEmitter<LearningEventMap>,
  ) {
    this.name = metadata.name;
    this.description = metadata.description;
    this.inputSchema = metadata.inputSchema;
    this.chainMetadata = metadata.chainMetadata;
    this.resilienceConfig = metadata.resilienceConfig ?? DEFAULT_RESILIENCE_CONFIG;
  }

  /** Get the ordered tool sequence for this chain */
  get toolSequence(): string[] {
    return this.chainMetadata.toolSequence;
  }

  /** Check if this composite tool contains the given tool in its chain */
  containsTool(name: string): boolean {
    return this.chainMetadata.toolSequence.includes(name);
  }

  // ===========================================================================
  // EXECUTE -- Route to V1 sequential, V2 sequential, or V2 DAG parallel
  // ===========================================================================

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    // TOOL-05: Execution-time validation -- ensure all tools still exist
    for (const toolName of this.chainMetadata.toolSequence) {
      if (!this.toolRegistry.has(toolName)) {
        this.emitChainEvent(false, [], Date.now());
        return {
          content: `Chain '${this.name}' failed: tool '${toolName}' no longer exists`,
          isError: true,
        };
      }
    }

    if (this.isV2Metadata()) {
      if (this.resilienceConfig.parallelEnabled) {
        return this.executeDAG(input, context);
      }
      return this.executeSequentialV2(input, context);
    }

    return this.executeSequentialV1(input, context);
  }

  // ===========================================================================
  // V2 DETECTION
  // ===========================================================================

  /** Check if chainMetadata is V2 format with steps array */
  private isV2Metadata(): boolean {
    return "version" in this.chainMetadata
      && (this.chainMetadata as ChainMetadataV2).version === 2
      && "steps" in this.chainMetadata;
  }

  // ===========================================================================
  // V1 SEQUENTIAL EXECUTION (unchanged from original)
  // ===========================================================================

  private async executeSequentialV1(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const stepResults: StepRecord[] = [];
    let previousOutput: Record<string, unknown> = {};
    const stepOutputs: Array<{ tool: string; output: string }> = [];

    for (let i = 0; i < this.chainMetadata.toolSequence.length; i++) {
      const toolName = this.chainMetadata.toolSequence[i]!;
      const stepInput = this.buildStepInput(i, input, previousOutput);
      const stepStart = Date.now();

      const result = await this.toolRegistry.execute(toolName, stepInput, context);
      const stepDuration = Date.now() - stepStart;
      const success = !result.isError;

      stepResults.push({ stepId: `step_${i}`, tool: toolName, success, durationMs: stepDuration });

      if (result.isError) {
        this.emitChainEvent(false, stepResults, startTime);
        return {
          content: `Chain '${this.name}' failed at step ${i + 1} (${toolName}): ${sanitizeSecrets(result.content).slice(0, 200)}`,
          isError: true,
        };
      }

      stepOutputs.push({ tool: toolName, output: result.content });
      previousOutput = this.parseStepOutput(result.content);
    }

    this.emitChainEvent(true, stepResults, startTime);
    const summary = stepOutputs
      .map((s, i) => `Step ${i + 1} [${s.tool}]: ${s.output}`)
      .join("\n");
    return { content: summary };
  }

  // ===========================================================================
  // V2 SEQUENTIAL EXECUTION (uses steps but no parallelism)
  // ===========================================================================

  private async executeSequentialV2(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const metadata = this.chainMetadata as ChainMetadataV2;
    const startTime = Date.now();
    const stepResults: StepRecord[] = [];
    const stepOutputMap = new Map<string, Record<string, unknown>>();
    const completedStepIds: string[] = [];
    const stepOutputSummary: Array<{ tool: string; output: string }> = [];

    // Execute steps in topological order (via computeChainWaves flattened)
    const waves = computeChainWaves(metadata.steps);
    const orderedSteps = waves.flat();

    for (const step of orderedSteps) {
      const stepInput = this.buildStepInputFromDAG(step, input, stepOutputMap);
      const stepStart = Date.now();

      const result = await this.toolRegistry.execute(step.toolName, stepInput, context);
      const stepDuration = Date.now() - stepStart;
      const success = !result.isError;

      stepResults.push({ stepId: step.stepId, tool: step.toolName, success, durationMs: stepDuration });

      if (result.isError) {
        return this.handleFailure(
          this.name,
          completedStepIds,
          stepOutputMap,
          metadata,
          context,
          stepResults,
          startTime,
          step.stepId,
        );
      }

      completedStepIds.push(step.stepId);
      stepOutputMap.set(step.stepId, this.parseStepOutput(result.content));
      stepOutputSummary.push({ tool: step.toolName, output: result.content });
    }

    this.emitChainEvent(true, stepResults, startTime);
    const summary = stepOutputSummary
      .map((s, i) => `Step ${i + 1} [${s.tool}]: ${s.output}`)
      .join("\n");
    return { content: summary };
  }

  // ===========================================================================
  // V2 DAG PARALLEL EXECUTION
  // ===========================================================================

  private async executeDAG(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const metadata = this.chainMetadata as ChainMetadataV2;
    const startTime = Date.now();
    const stepResults: StepRecord[] = [];
    const stepOutputMap = new Map<string, Record<string, unknown>>();
    const completedStepIds: string[] = [];
    const cancelledSteps: string[] = [];
    const stepOutputSummary: Array<{ tool: string; output: string }> = [];
    let maxParallelBranches = 0;

    const waves = computeChainWaves(metadata.steps);
    let failedStepId: string | undefined;

    for (const wave of waves) {
      if (failedStepId) break;

      const branchCount = Math.min(wave.length, this.resilienceConfig.maxParallelBranches);
      maxParallelBranches = Math.max(maxParallelBranches, wave.length);

      // Execute wave steps in parallel batches (capped at maxParallelBranches)
      const controller = new AbortController();
      const { signal } = controller;

      // Process in batches of maxParallelBranches
      for (let batchStart = 0; batchStart < wave.length; batchStart += branchCount) {
        if (failedStepId) break;

        const batch = wave.slice(batchStart, batchStart + branchCount);
        const promises = batch.map(async (step) => {
          // Check if aborted before starting
          if (signal.aborted) {
            return { step, result: null as ToolExecutionResult | null, aborted: true };
          }

          const stepInput = this.buildStepInputFromDAG(step, input, stepOutputMap);
          const stepStart = Date.now();

          const result = await this.toolRegistry.execute(step.toolName, stepInput, context);
          const stepDuration = Date.now() - stepStart;

          // If aborted during execution, treat as cancelled
          if (signal.aborted) {
            return { step, result: null, aborted: true };
          }

          const success = !result.isError;
          return {
            step,
            result,
            aborted: false,
            record: { stepId: step.stepId, tool: step.toolName, success, durationMs: stepDuration } as StepRecord,
          };
        });

        const settled = await Promise.allSettled(promises);

        for (const outcome of settled) {
          if (outcome.status === "rejected") {
            controller.abort();
            failedStepId = "unknown";
            break;
          }

          const { step, result, aborted, record } = outcome.value;

          if (aborted || !result) {
            cancelledSteps.push(step.stepId);
            continue;
          }

          stepResults.push(record!);

          if (result.isError) {
            controller.abort();
            failedStepId = step.stepId;
            // Mark remaining steps in this batch as cancelled
            for (const other of batch) {
              if (other.stepId !== step.stepId && !completedStepIds.includes(other.stepId)) {
                const alreadyCounted = cancelledSteps.includes(other.stepId)
                  || stepResults.some((r) => r.stepId === other.stepId);
                if (!alreadyCounted) {
                  cancelledSteps.push(other.stepId);
                }
              }
            }
            break;
          }

          completedStepIds.push(step.stepId);
          stepOutputMap.set(step.stepId, this.parseStepOutput(result.content));
          stepOutputSummary.push({ tool: step.toolName, output: result.content });
        }
      }
    }

    // Collect cancelled steps from remaining waves after failure
    if (failedStepId) {
      for (const wave of waves) {
        for (const step of wave) {
          if (
            !completedStepIds.includes(step.stepId)
            && step.stepId !== failedStepId
            && !cancelledSteps.includes(step.stepId)
            && !stepResults.some((r) => r.stepId === step.stepId && !r.success)
          ) {
            cancelledSteps.push(step.stepId);
          }
        }
      }

      return this.handleFailure(
        this.name,
        completedStepIds,
        stepOutputMap,
        metadata,
        context,
        stepResults,
        startTime,
        failedStepId,
        maxParallelBranches,
        cancelledSteps,
      );
    }

    // Success
    this.emitChainEvent(true, stepResults, startTime, {
      parallelBranches: maxParallelBranches,
    });

    const summary = stepOutputSummary
      .map((s, i) => `Step ${i + 1} [${s.tool}]: ${s.output}`)
      .join("\n");
    return { content: summary };
  }

  // ===========================================================================
  // FAILURE HANDLING (Rollback or Forward-Recovery)
  // ===========================================================================

  private async handleFailure(
    chainName: string,
    completedStepIds: string[],
    stepOutputMap: Map<string, Record<string, unknown>>,
    metadata: ChainMetadataV2,
    context: ToolContext,
    stepResults: StepRecord[],
    startTime: number,
    failedStepId: string,
    parallelBranches?: number,
    cancelledSteps?: string[],
  ): Promise<ToolExecutionResult> {
    if (metadata.isFullyReversible && this.resilienceConfig.rollbackEnabled) {
      // Saga rollback
      const rollbackReport = await executeRollback(
        chainName,
        completedStepIds,
        stepOutputMap,
        metadata,
        this.toolRegistry,
        context,
        this.resilienceConfig.compensationTimeoutMs,
        this.eventBus,
      );

      this.emitChainEvent(false, stepResults, startTime, {
        parallelBranches,
        cancelledSteps,
        rollbackReport,
      });

      return {
        content: `Chain '${chainName}' failed at step '${failedStepId}'. Rollback: ${rollbackReport.finalState}. Steps rolled back: ${rollbackReport.stepsRolledBack.length}`,
        isError: true,
      };
    }

    // Forward-recovery (non-reversible or rollback disabled)
    this.emitChainEvent(false, stepResults, startTime, {
      parallelBranches,
      cancelledSteps,
      forwardRecovery: true,
    });

    return {
      content: `Chain '${chainName}' failed at step '${failedStepId}'. Forward-recovery required: chain is not fully reversible or rollback is disabled.`,
      isError: true,
    };
  }

  // ===========================================================================
  // DAG INPUT BUILDING
  // ===========================================================================

  /**
   * Build input for a V2 DAG step using parameter mappings and stepId-keyed outputs.
   * Resolves sourceKey references like 'stepId.fieldName' from stepOutputMap.
   */
  private buildStepInputFromDAG(
    step: ChainStepNode,
    userInput: Record<string, unknown>,
    stepOutputMap: Map<string, Record<string, unknown>>,
  ): Record<string, unknown> {
    const metadata = this.chainMetadata as ChainMetadataV2;
    const stepInput: Record<string, unknown> = {};

    // Find step index for backward-compatible parameterMappings
    const stepIndex = metadata.steps.findIndex((s) => s.stepId === step.stepId);

    for (const mapping of metadata.parameterMappings) {
      if (mapping.stepIndex !== stepIndex) continue;

      switch (mapping.source) {
        case "userInput":
          if (mapping.sourceKey && mapping.sourceKey in userInput) {
            stepInput[mapping.parameterName] = userInput[mapping.sourceKey];
          } else if (mapping.defaultValue !== undefined) {
            stepInput[mapping.parameterName] = mapping.defaultValue;
          }
          break;

        case "previousOutput": {
          // V2: resolve sourceKey like 'stepId.field' from stepOutputMap
          const resolved = this.resolveDAGSourceKey(
            mapping.sourceKey,
            stepOutputMap,
          );
          if (resolved !== undefined) {
            stepInput[mapping.parameterName] = resolved;
          } else if (mapping.defaultValue !== undefined) {
            stepInput[mapping.parameterName] = mapping.defaultValue;
          }
          break;
        }

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
   * Resolve a DAG source key like 'stepId.fieldName' from the step output map.
   * Returns undefined if not found.
   */
  private resolveDAGSourceKey(
    sourceKey: string | undefined,
    stepOutputMap: Map<string, Record<string, unknown>>,
  ): unknown {
    if (!sourceKey) return undefined;

    // Try 'stepId.field' format first
    const dotIndex = sourceKey.indexOf(".");
    if (dotIndex > 0) {
      const stepId = sourceKey.slice(0, dotIndex);
      const field = sourceKey.slice(dotIndex + 1);
      const output = stepOutputMap.get(stepId);
      if (output && field in output) {
        return output[field];
      }
    }

    // Fallback: search all completed step outputs (insertion-order, earliest first)
    for (const [, output] of stepOutputMap) {
      if (sourceKey in output) {
        return output[sourceKey];
      }
    }

    return undefined;
  }

  // ===========================================================================
  // V1 INPUT BUILDING (unchanged)
  // ===========================================================================

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

  // ===========================================================================
  // OUTPUT PARSING (shared)
  // ===========================================================================

  /**
   * Parse step output into a record for the next step's parameter mapping.
   * Tries JSON.parse first; falls back to { result: content }.
   */
  private parseStepOutput(content: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === "object" && parsed !== null) {
        const safe: Record<string, unknown> = {};
        for (const key of Object.keys(parsed)) {
          if (key !== "__proto__" && key !== "constructor" && key !== "prototype") {
            safe[key] = (parsed as Record<string, unknown>)[key];
          }
        }
        return safe;
      }
      return { result: content };
    } catch {
      return { result: content };
    }
  }

  // ===========================================================================
  // EVENT EMISSION
  // ===========================================================================

  /**
   * Emit the chain:executed event with optional V2 fields.
   */
  private emitChainEvent(
    success: boolean,
    stepResults: StepRecord[],
    startTime: number,
    extra?: {
      parallelBranches?: number;
      cancelledSteps?: string[];
      rollbackReport?: RollbackReport;
      forwardRecovery?: boolean;
    },
  ): void {
    const now = Date.now();
    const event: ChainExecutionEvent = {
      chainName: this.name,
      success,
      stepResults,
      totalDurationMs: now - startTime,
      timestamp: now,
      ...(extra?.parallelBranches !== undefined && { parallelBranches: extra.parallelBranches }),
      ...(extra?.cancelledSteps && extra.cancelledSteps.length > 0 && { cancelledSteps: extra.cancelledSteps }),
      ...(extra?.rollbackReport && { rollbackReport: extra.rollbackReport }),
      ...(extra?.forwardRecovery !== undefined && { forwardRecovery: extra.forwardRecovery }),
    };
    this.eventBus.emit("chain:executed", event);
  }
}
