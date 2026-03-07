/**
 * Metrics Types
 *
 * Type definitions for the agent performance metrics system.
 * Covers task completion rate (EVAL-01), iterations per task (EVAL-02),
 * and pattern reuse rate (EVAL-03).
 */

// ─── Completion Status ───────────────────────────────────────────────────────

/** Three-state completion mapping from AgentPhase */
export type CompletionStatus = "success" | "failure" | "partial";

/** Task execution context type */
export type TaskType = "interactive" | "background" | "subtask";

// ─── Task Metric ─────────────────────────────────────────────────────────────

/** A single recorded task metric row */
export interface TaskMetric {
  /** Unique metric ID (metric_<uuid>) */
  readonly id: string;
  /** Chat ID serving as session identifier */
  readonly sessionId: string;
  /** Parent metric ID for subtasks, undefined for top-level tasks */
  readonly parentTaskId?: string;
  /** Execution context type */
  readonly taskType: TaskType;
  /** Truncated task description (max 200 chars) */
  readonly taskDescription: string;
  /** Final completion status */
  readonly completionStatus: CompletionStatus;
  /** Number of PAOR iterations (0 for background tasks) */
  readonly paorIterations: number;
  /** Total tool calls made during this task */
  readonly toolCallCount: number;
  /** Instinct IDs retrieved by InstinctRetriever for this task */
  readonly instinctIds: string[];
  /** Denormalized instinct count for fast aggregation */
  readonly instinctCount: number;
  /** Unix timestamp (ms) when task started */
  readonly startedAt: number;
  /** Unix timestamp (ms) when task completed */
  readonly completedAt: number;
  /** Duration in milliseconds */
  readonly durationMs: number;
}

// ─── Query Types ─────────────────────────────────────────────────────────────

/** Flexible filter for querying metrics (mutable DTO built incrementally) */
export interface MetricsFilter {
  /** Filter by session (chatId) */
  sessionId?: string;
  /** Filter by task type */
  taskType?: TaskType;
  /** Filter by completion status */
  completionStatus?: CompletionStatus;
  /** Only include metrics after this timestamp (ms) */
  since?: number;
  /** Only include metrics before this timestamp (ms) */
  until?: number;
  /** Maximum rows to return (default 100) */
  limit?: number;
}

/** Valid TaskType values for input validation */
export const VALID_TASK_TYPES = new Set<string>(["interactive", "background", "subtask"]);

/** Valid CompletionStatus values for input validation */
export const VALID_COMPLETION_STATUSES = new Set<string>(["success", "failure", "partial"]);

/** Aggregated metrics computed from filtered rows */
export interface MetricsAggregation {
  readonly totalTasks: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly partialCount: number;
  /** success / total (0-1) */
  readonly completionRate: number;
  /** Average PAOR iterations per task */
  readonly avgIterations: number;
  /** Average tool calls per task */
  readonly avgToolCalls: number;
  /** Number of tasks that had instinct guidance */
  readonly tasksWithInstincts: number;
  /** Percentage of tasks with instinct guidance (0-100) */
  readonly instinctReusePct: number;
  /** Average instincts per informed task (tasks with instinct_count > 0) */
  readonly avgInstinctsPerInformedTask: number;
}

// ─── Instinct Leaderboard ────────────────────────────────────────────────────

/** Per-instinct usage and success statistics */
export interface InstinctLeaderboardEntry {
  /** The instinct ID */
  readonly instinctId: string;
  /** Number of tasks that used this instinct */
  readonly usageCount: number;
  /** Success rate of tasks that used this instinct (0-1) */
  readonly taskSuccessRate: number;
}
