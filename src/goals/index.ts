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

// Renderer
export { renderGoalTree, summarizeTree } from "./goal-renderer.js";
