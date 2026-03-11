/**
 * Chain Rollback Executor
 *
 * Implements saga-pattern rollback for failed chain executions:
 * - Executes compensating actions in reverse completion order
 * - Handles compensation timeouts via AbortSignal.timeout
 * - Logs and continues on individual compensation failures
 * - Emits chain:rollback event with full detail
 * - Returns structured RollbackReport
 */

import type {
  ChainMetadataV2,
  ChainStepNode,
  RollbackReport,
  RollbackStepResult,
} from "./chain-types.js";
import type { ToolRegistry } from "../../core/tool-registry.js";
import type { ToolContext } from "../../agents/tools/tool-core.interface.js";
import type { IEventEmitter, LearningEventMap } from "../../core/event-bus.js";

// =============================================================================
// ROLLBACK EXECUTOR
// =============================================================================

/**
 * Execute saga rollback for a failed chain.
 *
 * Iterates completed steps in reverse order. For each step with a
 * compensating action, executes the compensation tool with mapped inputs.
 * On timeout or error, marks the step as rollbackFailed and continues
 * (log-and-continue pattern).
 *
 * @param chainName - Name of the chain being rolled back
 * @param completedStepIds - Step IDs that completed (in completion order)
 * @param stepOutputs - Map of stepId -> output from that step's execution
 * @param metadata - V2 chain metadata with step definitions
 * @param toolRegistry - Registry to look up compensation tools
 * @param context - Tool execution context (same as original execution)
 * @param timeoutMs - Per-step compensation timeout in milliseconds
 * @param eventBus - Event bus for emitting chain:rollback event
 * @returns RollbackReport with per-step results and overall state
 */
export async function executeRollback(
  chainName: string,
  completedStepIds: string[],
  stepOutputs: Map<string, Record<string, unknown>>,
  metadata: ChainMetadataV2,
  toolRegistry: ToolRegistry,
  context: ToolContext,
  timeoutMs: number,
  eventBus: IEventEmitter<LearningEventMap>,
): Promise<RollbackReport> {
  const startTime = Date.now();

  // Empty case -- nothing to roll back
  if (completedStepIds.length === 0) {
    const report: RollbackReport = {
      stepsCompleted: [],
      stepsRolledBack: [],
      rollbackFailures: [],
      finalState: "fully_rolled_back",
    };
    eventBus.emit("chain:rollback", {
      chainName,
      failedStep: "",
      compensationResults: [],
      totalDurationMs: 0,
      timestamp: Date.now(),
    });
    return report;
  }

  // Build step lookup
  const stepMap = new Map<string, ChainStepNode>();
  for (const step of metadata.steps) {
    stepMap.set(step.stepId, step);
  }

  // Execute compensations in reverse completion order
  const reversedIds = [...completedStepIds].reverse();
  const results: RollbackStepResult[] = [];
  const failures: string[] = [];

  for (const stepId of reversedIds) {
    const step = stepMap.get(stepId);
    if (!step?.compensatingAction) {
      // No compensation defined -- skip
      continue;
    }

    const { compensatingAction } = step;
    const stepStart = Date.now();

    try {
      // Build input from inputMappings + stepOutputs
      const stepOutput = stepOutputs.get(stepId) ?? {};
      const input: Record<string, unknown> = {};
      for (const [paramName, sourceKey] of Object.entries(compensatingAction.inputMappings)) {
        input[paramName] = stepOutput[sourceKey];
      }

      // Execute compensation tool with per-step timeout
      const tool = toolRegistry.get(compensatingAction.toolName);
      if (!tool) {
        throw new Error(`Compensation tool '${compensatingAction.toolName}' not found`);
      }

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Compensation timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      await Promise.race([tool.execute(input, context), timeoutPromise]);

      results.push({
        stepId,
        tool: compensatingAction.toolName,
        success: true,
        durationMs: Date.now() - stepStart,
        state: "rolledBack",
      });
    } catch {
      // Log-and-continue: mark as failed, proceed to next
      results.push({
        stepId,
        tool: compensatingAction.toolName,
        success: false,
        durationMs: Date.now() - stepStart,
        state: "rollbackFailed",
      });
      failures.push(stepId);
    }
  }

  // Compute final state
  const stepsWithCompensation = reversedIds.filter((id) => stepMap.get(id)?.compensatingAction);
  let finalState: RollbackReport["finalState"];
  if (failures.length === 0) {
    finalState = "fully_rolled_back";
  } else if (failures.length === stepsWithCompensation.length) {
    finalState = "rollback_failed";
  } else {
    finalState = "partially_rolled_back";
  }

  const report: RollbackReport = {
    stepsCompleted: completedStepIds,
    stepsRolledBack: results,
    rollbackFailures: failures,
    finalState,
  };

  // Emit chain:rollback event
  eventBus.emit("chain:rollback", {
    chainName,
    failedStep: completedStepIds[completedStepIds.length - 1] ?? "",
    compensationResults: results.map((r) => ({
      stepId: r.stepId,
      tool: r.tool,
      success: r.success,
      durationMs: r.durationMs,
      state: r.state,
    })),
    totalDurationMs: Date.now() - startTime,
    timestamp: Date.now(),
  });

  return report;
}
