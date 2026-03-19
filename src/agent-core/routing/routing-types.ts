/**
 * Multi-Provider Routing Types
 */

export type TaskType =
  | "planning"
  | "code-generation"
  | "code-review"
  | "simple-question"
  | "analysis"
  | "refactoring"
  | "destructive-operation"
  | "debugging";

export type TaskComplexity = "trivial" | "simple" | "moderate" | "complex";
export type TaskCriticality = "low" | "medium" | "high" | "critical";

export interface TaskClassification {
  readonly type: TaskType;
  readonly complexity: TaskComplexity;
  readonly criticality: TaskCriticality;
}

export type RoutingPreset = "budget" | "balanced" | "performance";

export interface RoutingWeights {
  readonly costWeight: number;
  readonly capabilityWeight: number;
  readonly speedWeight: number;
  readonly diversityWeight: number;
}

export interface RoutingDecision {
  readonly provider: string;
  readonly reason: string;
  readonly task: TaskClassification;
  readonly timestamp: number;
  readonly identityKey?: string;
  readonly catalogSignal?: {
    readonly freshnessScore: number;
    readonly alignmentScore: number;
    readonly stale: boolean;
    readonly updatedAt?: number;
  };
  readonly replaySignal?: {
    readonly phase: ExecutionPhase;
    readonly score: number;
    readonly sampleSize: number;
    readonly sameWorldMatches: number;
    readonly latestTimestamp: number;
  };
}

export type ExecutionRole = "planner" | "executor" | "reviewer" | "synthesizer";
export type ExecutionPhase =
  | "planning"
  | "executing"
  | "reflecting"
  | "replanning"
  | "synthesis"
  | "clarification-review"
  | "completion-review"
  | "consensus-review"
  | "shell-review";
export type ExecutionTraceSource =
  | "supervisor-strategy"
  | "tool-turn-affinity"
  | "synthesis"
  | "clarification-review"
  | "completion-review"
  | "consensus-review"
  | "shell-review";

export interface ExecutionTrace {
  readonly provider: string;
  readonly model?: string;
  readonly role: ExecutionRole;
  readonly phase: ExecutionPhase;
  readonly source: ExecutionTraceSource;
  readonly reason: string;
  readonly task: TaskClassification;
  readonly timestamp: number;
  readonly identityKey?: string;
  readonly chatId?: string;
  readonly taskRunId?: string;
}

export type PhaseOutcomeStatus =
  | "approved"
  | "continued"
  | "replanned"
  | "blocked"
  | "failed";

export type VerifierDecision = "approve" | "continue" | "replan";

export interface PhaseOutcomeTelemetry {
  readonly verifierDecision?: VerifierDecision;
  readonly retryCount?: number;
  readonly rollbackDepth?: number;
  readonly failureFingerprint?: string;
  readonly projectWorldFingerprint?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface PhaseOutcome {
  readonly provider: string;
  readonly model?: string;
  readonly role: ExecutionRole;
  readonly phase: ExecutionPhase;
  readonly source: ExecutionTraceSource;
  readonly status: PhaseOutcomeStatus;
  readonly reason: string;
  readonly task: TaskClassification;
  readonly timestamp: number;
  readonly identityKey?: string;
  readonly chatId?: string;
  readonly taskRunId?: string;
  readonly telemetry?: PhaseOutcomeTelemetry;
}

export interface PhaseScore {
  readonly provider: string;
  readonly role: ExecutionRole;
  readonly phase: ExecutionPhase;
  readonly sampleSize: number;
  readonly score: number;
  readonly approvedCount: number;
  readonly continuedCount: number;
  readonly replannedCount: number;
  readonly blockedCount: number;
  readonly failedCount: number;
  readonly verifierSampleSize: number;
  readonly verifierCleanRate: number;
  readonly rollbackRate: number;
  readonly avgRetryCount: number;
  readonly avgTokenCost: number;
  readonly repeatedFailureCount: number;
  readonly repeatedWorldContextCount: number;
  readonly latestTimestamp: number;
  readonly latestReason: string;
  readonly identityKey?: string;
}

export interface OriginalOutput {
  readonly text?: string;
  readonly toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
}

export type ConsensusStrategy = "review" | "re-execute" | "skip";

export interface ConsensusResult {
  readonly agreed: boolean;
  readonly strategy: ConsensusStrategy;
  readonly originalProvider: string;
  readonly reviewProvider?: string;
  readonly reasoning?: string;
}
