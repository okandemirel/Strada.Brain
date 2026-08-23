/**
 * Goal execution result shape.
 *
 * Lives here (not in a specific engine) because both the retired wave-based
 * GoalExecutor and the current SupervisorDispatcher path produce this shape,
 * and the orchestrator's final-answer synthesis consumes it.
 */

import type { GoalTree, GoalNodeId } from "./types.js";

export interface ExecutionResult {
  tree: GoalTree;
  results: Array<{ nodeId: GoalNodeId; task: string; result?: string; error?: string }>;
  totalDurationMs: number;
  failureCount: number;
  aborted: boolean;
}
