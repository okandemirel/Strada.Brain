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
