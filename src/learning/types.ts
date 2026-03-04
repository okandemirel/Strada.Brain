/**
 * Learning Types
 * 
 * Core type definitions for Experience Replay & Pattern Learning system.
 * Defines Instincts, Trajectories, Verdicts, Error Patterns and Pattern Matches.
 * Updated for type safety with branded types and discriminated unions.
 */

import type {
  SessionId,
  ToolName,
  ChatId,
  NormalizedScore,
  TimestampMs,
  DurationMs,
  JsonObject,
} from "../types/index.js";

// =============================================================================
// BRANDED TYPES
// =============================================================================

/** Instinct identifier */
export type InstinctId = `instinct_${string}`;

/** Trajectory identifier */
export type TrajectoryId = `traj_${string}`;

/** Verdict identifier */
export type VerdictId = `verdict_${string}`;

/** Error pattern identifier */
export type ErrorPatternId = `error_${string}`;

/** Observation identifier */
export type ObservationId = `obs_${string}`;

/** Solution identifier */
export type SolutionId = `sol_${string}`;

/** Evolution proposal identifier */
export type EvolutionProposalId = `evolution_${string}`;

/** Context condition identifier */
export type ContextConditionId = `ctx_${string}`;

// =============================================================================
// INSTINCT TYPES
// =============================================================================

/** Types of instincts that can be learned */
export type InstinctType = 
  | "error_fix"      // Fix for specific error patterns
  | "tool_usage"     // Optimized tool usage patterns
  | "correction"     // User correction patterns
  | "verification"   // Verification sequence patterns
  | "optimization";  // Performance optimization patterns

/** Lifecycle status of an instinct */
export type InstinctStatus = 
  | "proposed"   // New instinct, needs more validation
  | "active"     // Validated and active
  | "deprecated" // No longer effective
  | "evolved";   // Evolved to a higher form (skill/command/agent)

/** Confidence level thresholds */
export const CONFIDENCE_THRESHOLDS = {
  PROPOSED: 0.0,    // Starting confidence
  ACTIVE: 0.7,      // Threshold to become active
  DEPRECATED: 0.3,  // Threshold below which instinct is deprecated
  EVOLUTION: 0.9,   // Threshold for evolution consideration
} as const;

/** Context condition type */
export type ContextConditionType =
  | "file_type"
  | "error_code"
  | "tool_name"
  | "command_type"
  | "language"
  | "project_type"
  | "custom";

/** Match mode for context conditions */
export type MatchMode = "include" | "exclude" | "regex" | "fuzzy";

/** Context condition for instinct applicability */
export interface ContextCondition {
  readonly id: ContextConditionId;
  /** Type of condition */
  readonly type: ContextConditionType;
  /** Condition value/pattern */
  readonly value: string;
  /** Whether condition must match or must NOT match */
  readonly match: MatchMode;
  /** Weight for scoring (default: 1) */
  readonly weight?: number;
  /** Description for debugging */
  readonly description?: string;
}

/** Statistics for an instinct */
export interface InstinctStats {
  /** Times this instinct was suggested */
  readonly timesSuggested: number;
  /** Times this instinct was applied successfully */
  readonly timesApplied: number;
  /** Times this instinct failed */
  readonly timesFailed: number;
  /** Success rate (0.0 - 1.0) */
  readonly successRate: NormalizedScore;
  /** Average execution time */
  readonly averageExecutionMs: number;
  /** First applied at */
  readonly firstAppliedAt?: TimestampMs;
  /** Last applied at */
  readonly lastAppliedAt?: TimestampMs;
}

/** An instinct is an atomic learned pattern */
export interface Instinct {
  /** Unique identifier */
  readonly id: InstinctId;
  /** Human-readable name */
  readonly name: string;
  /** Type of instinct */
  readonly type: InstinctType;
  /** Current lifecycle status */
  readonly status: InstinctStatus;
  /** Confidence score (0.0 - 1.0) */
  readonly confidence: NormalizedScore;
  /** Pattern that triggers this instinct */
  readonly triggerPattern: string;
  /** The learned solution/action */
  readonly action: string;
  /** Context conditions for applicability */
  readonly contextConditions: ContextCondition[];
  /** Usage statistics */
  readonly stats: InstinctStats;
  /** When created */
  readonly createdAt: TimestampMs;
  /** Last updated */
  readonly updatedAt: TimestampMs;
  /** Optional evolution reference */
  readonly evolvedTo?: InstinctId;
  /** Source trajectory IDs */
  readonly sourceTrajectoryIds: TrajectoryId[];
  /** Tags for categorization */
  readonly tags: string[];
  /** Optional pre-computed embedding vector for semantic search */
  readonly embedding?: number[];
}

// =============================================================================
// TRAJECTORY TYPES
// =============================================================================

/** Error category */
export type ErrorCategory =
  | "syntax"
  | "runtime"
  | "logic"
  | "permission"
  | "network"
  | "timeout"
  | "validation"
  | "resource"
  | "unknown";

/** Error details for trajectory steps */
export interface ErrorDetails {
  /** Error code if available */
  readonly code?: string;
  /** Error category */
  readonly category: ErrorCategory;
  /** Error message */
  readonly message: string;
  /** File affected */
  readonly file?: string;
  /** Line number */
  readonly line?: number;
  /** Stack trace (truncated) */
  readonly stackTrace?: string;
  /** Suggested fixes */
  readonly suggestedFixes?: string[];
}

/** Trajectory step result */
export type TrajectoryStepResult =
  | { readonly kind: "success"; readonly output: string; readonly data?: JsonObject }
  | { readonly kind: "error"; readonly error: ErrorDetails }
  | { readonly kind: "cancelled"; readonly reason?: string }
  | { readonly kind: "timeout"; readonly limitMs: number };

/** A single step in a trajectory */
export interface TrajectoryStep {
  /** Step number in sequence */
  readonly stepNumber: number;
  /** Tool/command used */
  readonly toolName: ToolName;
  /** Input/parameters */
  readonly input: JsonObject;
  /** Result of the step */
  readonly result: TrajectoryStepResult;
  /** Timestamp */
  readonly timestamp: TimestampMs;
  /** Execution duration */
  readonly durationMs: DurationMs;
  /** Instinct applied (if any) */
  readonly appliedInstinctId?: InstinctId;
  /** Context at time of execution */
  readonly context?: JsonObject;
}

/** Outcome of a trajectory */
export interface TrajectoryOutcome {
  /** Whether the task was completed successfully */
  readonly success: boolean;
  /** Final state/output */
  readonly finalOutput?: string;
  /** Number of steps taken */
  readonly totalSteps: number;
  /** Whether there were errors */
  readonly hadErrors: boolean;
  /** Error count */
  readonly errorCount: number;
  /** Duration in milliseconds */
  readonly durationMs: DurationMs;
  /** Completion percentage (0-1) */
  readonly completionRate: NormalizedScore;
}

/** A trajectory is a recorded execution path */
export interface Trajectory {
  /** Unique identifier */
  readonly id: TrajectoryId;
  /** Session/task identifier */
  readonly sessionId: SessionId;
  /** Chat ID if applicable */
  readonly chatId?: ChatId;
  /** Description of the task */
  readonly taskDescription: string;
  /** Sequence of steps */
  readonly steps: TrajectoryStep[];
  /** Final outcome */
  readonly outcome: TrajectoryOutcome;
  /** Associated instincts (if any were applied) */
  readonly appliedInstinctIds: InstinctId[];
  /** When recorded */
  readonly createdAt: TimestampMs;
  /** Whether this trajectory has been processed for learning */
  readonly processed: boolean;
  /** Processing metadata */
  readonly processingMetadata?: {
    readonly processedAt: TimestampMs;
    readonly insightsGenerated: number;
    readonly patternsDetected: string[];
  };
}

// =============================================================================
// VERDICT TYPES
// =============================================================================

/** Verdict judge type */
export type JudgeType = "human" | "automated" | "self" | "hybrid";

/** Dimensions of trajectory evaluation */
export interface VerdictDimensions {
  /** Efficiency of the solution (0-1) */
  readonly efficiency: NormalizedScore;
  /** Correctness of the result (0-1) */
  readonly correctness: NormalizedScore;
  /** Code/approach quality (0-1) */
  readonly quality: NormalizedScore;
  /** Adherence to best practices (0-1) */
  readonly bestPractices: NormalizedScore;
  /** Innovation/creativity (0-1) */
  readonly innovation?: NormalizedScore;
  /** Maintainability (0-1) */
  readonly maintainability?: NormalizedScore;
}

/** Verdict on a trajectory's quality */
export interface Verdict {
  /** Verdict ID */
  readonly id: VerdictId;
  /** Associated trajectory ID */
  readonly trajectoryId: TrajectoryId;
  /** Judge type */
  readonly judgeType: JudgeType;
  /** Judge identifier (user ID or system name) */
  readonly judgeId: string;
  /** Overall score (0.0 - 1.0) */
  readonly score: NormalizedScore;
  /** Specific dimensions scored */
  readonly dimensions: VerdictDimensions;
  /** Comments/feedback */
  readonly feedback?: string;
  /** When judged */
  readonly createdAt: TimestampMs;
  /** Override flags */
  readonly overrides?: {
    readonly manualOverride?: boolean;
    readonly previousVerdictId?: VerdictId;
    readonly reason?: string;
  };
}

// =============================================================================
// ERROR PATTERN TYPES
// =============================================================================

/** A learned error pattern */
export interface ErrorPattern {
  /** Unique identifier */
  readonly id: ErrorPatternId;
  /** Human-readable name */
  readonly name: string;
  /** Error category */
  readonly category: ErrorCategory;
  /** Error code pattern (regex) */
  readonly codePattern?: string;
  /** Error message pattern (regex) */
  readonly messagePattern: string;
  /** Stack trace pattern (regex) */
  readonly stackPattern?: string;
  /** File patterns where this error occurs */
  readonly filePatterns: string[];
  /** Tool patterns where this error occurs */
  readonly toolPatterns?: string[];
  /** Frequency of occurrence */
  readonly occurrenceCount: number;
  /** Associated instinct (solution) */
  readonly solutionInstinctId?: InstinctId;
  /** When first seen */
  readonly firstSeen: TimestampMs;
  /** When last seen */
  readonly lastSeen: TimestampMs;
  /** Average resolution time */
  readonly averageResolutionMs?: DurationMs;
  /** Whether pattern is still active */
  readonly isActive: boolean;
}

// =============================================================================
// PATTERN MATCH TYPES
// =============================================================================

/** Match type */
export type MatchType = "exact" | "fuzzy" | "contextual" | "error_code" | "semantic";

/** Result of a pattern match operation */
export interface PatternMatch {
  /** Matched instinct/pattern ID */
  readonly id: InstinctId | ErrorPatternId;
  /** Type of match */
  readonly type: MatchType;
  /** Confidence score (0.0 - 1.0) */
  readonly confidence: NormalizedScore;
  /** Relevance score based on context */
  readonly relevance: NormalizedScore;
  /** Matched instinct/pattern */
  readonly instinct?: Instinct;
  readonly errorPattern?: ErrorPattern;
  /** Reason for match */
  readonly matchReason: string;
  /** Matched context fields */
  readonly matchedFields: string[];
  /** Suggested priority (higher = apply first) */
  readonly priority: number;
}

/** Input for pattern matching */
export interface PatternMatchInput {
  /** Error code if applicable */
  readonly errorCode?: string;
  /** Error message */
  readonly errorMessage?: string;
  /** Error category */
  readonly errorCategory?: ErrorCategory;
  /** File path if applicable */
  readonly filePath?: string;
  /** Tool name if applicable */
  readonly toolName?: ToolName;
  /** Programming language */
  readonly language?: string;
  /** Current context */
  readonly context?: JsonObject;
  /** Session ID for history context */
  readonly sessionId?: SessionId;
}

/** Pattern matching result */
export interface PatternMatchingResult {
  readonly matches: PatternMatch[];
  readonly topMatch?: PatternMatch;
  readonly executionTimeMs: DurationMs;
  readonly patternsChecked: number;
}

// =============================================================================
// LEARNING CONFIGURATION TYPES
// =============================================================================

/** Learning strategy */
export type LearningStrategy = 
  | "immediate"      // Learn from each observation
  | "batch"          // Batch process observations
  | "periodic"       // Periodic learning runs
  | "on_demand";     // Only when explicitly requested

/** Configuration for the learning pipeline */
export interface LearningConfig {
  /** Storage database path */
  readonly dbPath: string;
  /** Batch size for processing */
  readonly batchSize: number;
  /** Interval between detection batches (ms) */
  readonly detectionIntervalMs: DurationMs;
  /** Interval between evolution runs (ms) */
  readonly evolutionIntervalMs: DurationMs;
  /** Minimum confidence for instinct creation */
  readonly minConfidenceForCreation: NormalizedScore;
  /** Maximum number of instincts to keep */
  readonly maxInstincts: number;
  /** Whether learning is enabled */
  readonly enabled: boolean;
  /** Learning strategy */
  readonly strategy: LearningStrategy;
  /** Minimum observations before learning */
  readonly minObservationsBeforeLearning: number;
  /** Auto-archive instincts below threshold */
  readonly autoArchiveThreshold: NormalizedScore;
}

/** Default learning configuration */
export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  dbPath: "./data/learning.db",
  batchSize: 10,
  detectionIntervalMs: 5 * 60 * 1000 as DurationMs, // 5 minutes
  evolutionIntervalMs: 60 * 60 * 1000 as DurationMs, // 1 hour
  minConfidenceForCreation: 0.6 as NormalizedScore,
  maxInstincts: 1000,
  enabled: true,
  strategy: "periodic",
  minObservationsBeforeLearning: 5,
  autoArchiveThreshold: 0.2 as NormalizedScore,
};

// =============================================================================
// SOLUTION TYPES
// =============================================================================

/** Solution type */
export type SolutionType = "code" | "command" | "config" | "workflow" | "explanation";

/** A recorded solution to an error */
export interface Solution {
  /** Unique identifier */
  readonly id: SolutionId;
  /** Associated error pattern ID */
  readonly errorPatternId?: ErrorPatternId;
  /** Solution type */
  readonly type: SolutionType;
  /** Solution description */
  readonly description: string;
  /** Solution code/action */
  readonly action: string;
  /** Success count */
  readonly successCount: number;
  /** Total attempts */
  readonly totalAttempts: number;
  /** Success rate */
  readonly successRate: NormalizedScore;
  /** When created */
  readonly createdAt: TimestampMs;
  /** When last used */
  readonly lastUsed?: TimestampMs;
  /** Source instinct if evolved from one */
  readonly sourceInstinctId?: InstinctId;
}

// =============================================================================
// OBSERVATION TYPES
// =============================================================================

/** Observation type */
export type ObservationType = 
  | "tool_use"
  | "correction"
  | "error"
  | "success"
  | "feedback"
  | "verification";

/** A raw observation for learning */
export interface Observation {
  /** Unique identifier */
  readonly id: ObservationId;
  /** Type of observation */
  readonly type: ObservationType;
  /** Related session ID */
  readonly sessionId: SessionId;
  /** Chat ID if applicable */
  readonly chatId?: ChatId;
  /** Tool or command name */
  readonly toolName?: ToolName;
  /** Input parameters */
  readonly input?: JsonObject;
  /** Output/result */
  readonly output?: string;
  /** Whether it was successful */
  readonly success?: boolean;
  /** Error details if applicable */
  readonly errorDetails?: ErrorDetails;
  /** Corrective action taken */
  readonly correction?: string;
  /** User feedback if any */
  readonly feedback?: string;
  /** When observed */
  readonly timestamp: TimestampMs;
  /** Whether processed */
  readonly processed: boolean;
  /** Associated trajectory */
  readonly trajectoryId?: TrajectoryId;
}

// =============================================================================
// EVOLUTION TYPES
// =============================================================================

/** Evolution target types */
export type EvolutionTarget = "skill" | "command" | "agent" | "workflow";

/** Evolution status */
export type EvolutionStatus = "pending" | "approved" | "rejected" | "implemented" | "cancelled";

/** Evolution proposal */
export interface EvolutionProposal {
  /** Proposal ID */
  readonly id: EvolutionProposalId;
  /** Source instinct ID */
  readonly instinctId: InstinctId;
  /** Target evolution type */
  readonly targetType: EvolutionTarget;
  /** Proposed name */
  readonly name: string;
  /** Description of the evolved form */
  readonly description: string;
  /** Confidence in this evolution */
  readonly confidence: NormalizedScore;
  /** Proposed implementation */
  readonly implementation?: string;
  /** Status of the proposal */
  readonly status: EvolutionStatus;
  /** When proposed */
  readonly proposedAt: TimestampMs;
  /** When decided */
  readonly decidedAt?: TimestampMs;
  /** Reviewer/decider */
  readonly decidedBy?: string;
  /** Rejection reason if rejected */
  readonly rejectionReason?: string;
  /** Estimated impact score */
  readonly estimatedImpact?: NormalizedScore;
  /** Affected trajectories */
  readonly affectedTrajectoryIds: TrajectoryId[];
}

// =============================================================================
// TYPE GUARDS
// =============================================================================

/** Check if step result is success */
export function isStepSuccess(result: TrajectoryStepResult): result is { kind: "success"; output: string; data?: JsonObject } {
  return result.kind === "success";
}

/** Check if step result is error */
export function isStepError(result: TrajectoryStepResult): result is { kind: "error"; error: ErrorDetails } {
  return result.kind === "error";
}

/** Check if instinct is active */
export function isActiveInstinct(instinct: Instinct): boolean {
  return instinct.status === "active";
}

/** Check if instinct can evolve */
export function canEvolve(instinct: Instinct): boolean {
  return instinct.status === "active" && instinct.confidence >= CONFIDENCE_THRESHOLDS.EVOLUTION;
}

/** Check if trajectory was successful */
export function isSuccessfulTrajectory(trajectory: Trajectory): boolean {
  return trajectory.outcome.success && !trajectory.outcome.hadErrors;
}

/** Check if pattern match has high confidence */
export function isHighConfidenceMatch(match: PatternMatch, threshold = 0.8): boolean {
  return match.confidence >= threshold && match.relevance >= threshold;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Create a new instinct ID
 */
export function createInstinctId(): InstinctId {
  return `instinct_${Date.now()}_${Math.random().toString(36).slice(2, 9)}` as InstinctId;
}

/**
 * Create a new trajectory ID
 */
export function createTrajectoryId(): TrajectoryId {
  return `traj_${Date.now()}_${Math.random().toString(36).slice(2, 9)}` as TrajectoryId;
}

/**
 * Create a new verdict ID
 */
export function createVerdictId(): VerdictId {
  return `verdict_${Date.now()}_${Math.random().toString(36).slice(2, 9)}` as VerdictId;
}

/**
 * Calculate average dimension score */
export function calculateAverageScore(dimensions: VerdictDimensions): NormalizedScore {
  const values = [
    dimensions.efficiency,
    dimensions.correctness,
    dimensions.quality,
    dimensions.bestPractices,
    dimensions.innovation,
    dimensions.maintainability,
  ].filter((v): v is NormalizedScore => v !== undefined);
  
  const sum = values.reduce((a, b) => a + b, 0);
  return (sum / values.length) as NormalizedScore;
}

/**
 * Update instinct statistics after application
 */
export function updateInstinctStats(
  stats: InstinctStats,
  success: boolean,
  executionMs: number
): InstinctStats {
  const total = stats.timesApplied + stats.timesFailed + (success ? 1 : 0) + (success ? 0 : 1);
  const successes = stats.timesApplied + (success ? 1 : 0);
  
  return {
    timesSuggested: stats.timesSuggested,
    timesApplied: stats.timesApplied + (success ? 1 : 0),
    timesFailed: stats.timesFailed + (success ? 0 : 1),
    successRate: (successes / total) as NormalizedScore,
    averageExecutionMs: (stats.averageExecutionMs * stats.timesApplied + executionMs) / (stats.timesApplied + 1),
    firstAppliedAt: stats.firstAppliedAt ?? Date.now() as TimestampMs,
    lastAppliedAt: Date.now() as TimestampMs,
  };
}

/**
 * Sort matches by relevance (confidence * relevance)
 */
export function sortMatchesByRelevance(matches: PatternMatch[]): PatternMatch[] {
  return [...matches].sort((a, b) => {
    const scoreA = a.confidence * a.relevance;
    const scoreB = b.confidence * b.relevance;
    return scoreB - scoreA;
  });
}
