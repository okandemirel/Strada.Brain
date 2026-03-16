/**
 * Agent Core Types
 */

export type ActionType = "execute" | "wait" | "notify" | "escalate";

export interface ActionDecision {
  readonly action: ActionType;
  readonly goal?: string;       // For "execute"
  readonly message?: string;    // For "notify"
  readonly question?: string;   // For "escalate"
  readonly reasoning: string;   // LLM's reasoning (for logging)
}

export interface AgentCoreConfig {
  /** Minimum observation priority to trigger LLM reasoning (0-100) */
  minObservationPriority: number;
  /** Minimum interval between LLM reasoning calls in ms */
  minReasoningIntervalMs: number;
  /** Budget floor percentage — skip reasoning if budget below this % remaining */
  budgetFloorPct: number;
}

export const DEFAULT_AGENT_CORE_CONFIG: AgentCoreConfig = {
  minObservationPriority: 30,
  minReasoningIntervalMs: 30_000,
  budgetFloorPct: 10,
};
