/**
 * Learning Module
 * 
 * Experience Replay & Pattern Learning system for Strata.Brain.
 * 
 * This module provides:
 * - Instinct-based learning from errors and corrections
 * - Trajectory recording for experience replay
 * - Pattern matching for error recovery
 * - Confidence scoring with Bayesian updates
 * - Evolution from instincts to skills/commands
 * 
 * @example
 * ```typescript
 * import { LearningPipeline, LearningStorage, ErrorLearningHooks } from "./learning/index.js";
 * 
 * // Initialize storage
 * const storage = new LearningStorage("./data/learning.db");
 * storage.initialize();
 * 
 * // Create and start pipeline
 * const pipeline = new LearningPipeline(storage);
 * pipeline.start();
 * 
 * // Observe tool usage
 * pipeline.observeToolUse({
 *   sessionId: "session-123",
 *   toolName: "dotnet_build",
 *   input: { args: ["--configuration", "Release"] },
 *   output: "Build failed...",
 *   success: false,
 * });
 * ```
 */

// Core exports
export { LearningStorage, type LearningStats } from "./storage/learning-storage.js";
export { LearningPipeline } from "./pipeline/learning-pipeline.js";
export { ConfidenceScorer, calculateEloRating, wilsonScoreInterval } from "./scoring/confidence-scorer.js";
export { PatternMatcher, extractKeywords, jaccardSimilarity } from "./matching/pattern-matcher.js";
export { ErrorLearningHooks, type ErrorContext, type ResolutionContext } from "./hooks/error-learning-hooks.js";

// Type exports
export type {
  Instinct,
  InstinctType,
  InstinctStatus,
  InstinctStats,
  ContextCondition,
  Trajectory,
  TrajectoryStep,
  TrajectoryStepResult,
  TrajectoryOutcome,
  Observation,
  ErrorPattern,
  Solution,
  Verdict,
  VerdictDimensions,
  PatternMatch,
  PatternMatchInput,
  EvolutionTarget,
  EvolutionProposal,
  LearningConfig,
  ErrorDetails,
} from "./types.js";

// Constants
export { CONFIDENCE_THRESHOLDS, DEFAULT_LEARNING_CONFIG } from "./types.js";
