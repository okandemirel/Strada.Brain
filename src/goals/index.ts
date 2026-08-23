/**
 * Goal Decomposition Module
 *
 * Public API for recursive goal decomposition system.
 * Exports types, DAG validation, storage, decomposer, and renderer.
 */

// Types
export type {
  GoalNode,
  GoalTree,
  GoalNodeId,
  GoalStatus,
  GoalLifecycleEvent,
  LLMDecompositionOutput,
} from "./types.js";
export {
  llmDecompositionSchema,
  generateGoalNodeId,
  parseLLMOutput,
} from "./types.js";

// DAG Validation
export { validateDAG } from "./goal-validator.js";
export type { DAGValidationResult } from "./goal-validator.js";

// Storage
export { GoalStorage } from "./goal-storage.js";

// Decomposer
export { GoalDecomposer } from "./goal-decomposer.js";
export type { DecompositionContext } from "./goal-decomposer.js";

// Renderer
export { renderGoalTree, summarizeTree } from "./goal-renderer.js";
export type { GoalRendererOptions } from "./goal-renderer.js";
export { buildGoalNarrativeFeedback, formatGoalPlanMarkdown } from "./goal-feedback.js";
export type { GoalNarrativeFeedback } from "./goal-feedback.js";

// Progress
export { calculateProgress, renderProgressBar } from "./goal-progress.js";
export type { ProgressInfo } from "./goal-progress.js";

// Executor
export type { ExecutionResult } from "./execution-result.js";

// Resume
export {
  detectInterruptedTrees,
  prepareTreeForResume,
  isTreeStale,
  formatResumePrompt,
} from "./goal-resume.js";
