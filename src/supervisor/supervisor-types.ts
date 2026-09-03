/**
 * Supervisor Brain - Shared Types
 *
 * Core type definitions for the multi-provider supervisor orchestration layer.
 * Defines capability tagging, node results, verification, and configuration.
 *
 * All interfaces use readonly fields for immutability.
 */

import type { GoalNode, GoalNodeId, GoalTree } from "../goals/types.js";
import type { WorkerExecutionEnvelope } from "../agents/supervisor/supervisor-types.js";
import type { ToolResult } from "../agents/providers/provider-core.interface.js";

// =============================================================================
// CAPABILITY TAGGING
// =============================================================================

/** Tags describing provider/model capabilities */
export type CapabilityTag =
  | "reasoning"
  | "vision"
  | "code-gen"
  | "tool-use"
  | "long-context"
  | "speed"
  | "cost"
  | "quality"
  | "creative";

/** Capability profile for a goal node, used for provider matching */
export interface CapabilityProfile {
  readonly primary: CapabilityTag[];
  readonly preference: "speed" | "cost" | "quality";
  readonly confidence: number;
  readonly source: "heuristic" | "llm-triage" | "hybrid";
}

// =============================================================================
// TAGGED GOAL NODE
// =============================================================================

/** A GoalNode extended with capability tagging and provider assignment */
export interface TaggedGoalNode extends GoalNode {
  readonly capabilityProfile: CapabilityProfile;
  /**
   * The node's own time budget, stated by the dispatcher so the worker can
   * land a smaller increment instead of being killed at the deadline with
   * nothing salvaged (audited 2026-09-03). Not part of the visible label.
   */
  readonly timeBudgetNotice?: string;
  readonly assignedProvider?: string;
  readonly assignedModel?: string;
}

// =============================================================================
// PROVIDER SCORING
// =============================================================================

/** Scored provider/model candidate for a goal node */
export interface ProviderScore {
  readonly providerName: string;
  readonly model: string;
  readonly score: number;
  readonly breakdown: {
    readonly capabilityScore: number;
    readonly preferenceScore: number;
    readonly historyScore: number;
  };
}

// =============================================================================
// NODE EXECUTION RESULTS
// =============================================================================

/** Result of executing a single goal node */
export interface NodeResult {
  readonly nodeId: GoalNodeId;
  // "cancelled" = the node was stopped by a control-plane abort (sibling winddown,
  // task cancel) rather than failing — excluded from the success/failure gate so a
  // benign cancel cannot downgrade an otherwise-successful task (audit #13).
  readonly status: "ok" | "failed" | "skipped" | "cancelled";
  readonly output: string;
  readonly blockedReason?: string;
  readonly artifacts: FileChange[];
  readonly toolResults: ToolResult[];
  readonly provider: string;
  readonly model: string;
  readonly cost: number;
  readonly duration: number;
}

/** A file change produced by node execution */
export interface FileChange {
  readonly path: string;
  readonly action: "create" | "modify" | "delete";
}

// =============================================================================
// VERIFICATION
// =============================================================================

/**
 * Verdict from cross-provider verification of a node result.
 *
 * "skipped" means no verifier looked at the node (audited 2026-09-02): the
 * critical-only wrapper used to answer "approve" for every non-critical node,
 * so a run in which nothing was verified reported the same verdict as one in
 * which everything passed. A skip is neither a pass nor a failure and is
 * counted as "not verified" in the VerificationReport.
 */
export interface VerificationVerdict {
  readonly verdict: "approve" | "flag_issues" | "reject" | "skipped";
  readonly issues?: string[];
  readonly verifierProvider: string;
}

/** What the verify stage actually measured — so a skipped check never reads like a passed one. */
export interface VerificationReport {
  /**
   * Nodes that finished "ok" and were in the active mode's scope — under
   * "critical-only" that is the critical nodes alone, not every ok node
   * (audited 2026-09-02: it counted every ok node, so a run that verified all
   * of its critical nodes still reported most of the plan as unverified).
   * A node outside the scope is not a skipped check; nothing was ever due on
   * it. Coverage the mode DID owe and did not deliver — no verifier wired,
   * budget, sampling, a "skipped" verdict — still shows up as notVerified.
   */
  readonly candidates: number;
  /** Nodes a verifier actually rendered a verdict on (approve / flag_issues / reject). */
  readonly verified: number;
  readonly approved: number;
  readonly flagged: number;
  readonly rejected: number;
  /** Candidates no verifier looked at: mode disabled, no verifier, budget, sampling, or a "skipped" verdict. */
  readonly notVerified: number;
}

/** Configuration for the verification subsystem */
export interface VerificationConfig {
  readonly mode: "always" | "critical-only" | "sampling" | "disabled";
  readonly samplingRate: number;
  readonly preferDifferentProvider: boolean;
  readonly maxVerificationCost: number;
}

// =============================================================================
// SUPERVISOR CONFIGURATION
// =============================================================================

/** Top-level configuration for the Supervisor Brain */
export interface SupervisorConfig {
  readonly enabled: boolean;
  readonly complexityThreshold: "moderate" | "complex";
  readonly maxParallelNodes: number;
  readonly nodeTimeoutMs: number;
  readonly verificationMode: VerificationConfig["mode"];
  readonly verificationBudgetPct: number;
  readonly triageProvider: string;
  readonly maxFailureBudget: number;
  readonly diversityCap: number;
}

// =============================================================================
// SUPERVISOR CONTEXT & RESULT
// =============================================================================

/** Runtime context passed into the supervisor for a single invocation */
export interface SupervisorContext extends WorkerExecutionEnvelope {
  readonly signal?: AbortSignal;
  readonly userContent?: string | import("../agents/providers/provider-core.interface.js").MessageContent[] | null;
  readonly planningPrompt?: string;
  readonly goalTree?: GoalTree;
  readonly onGoalDecomposed?: (goalTree: GoalTree) => void;
  readonly reportUpdate?: (markdown: string) => Promise<void> | void;
  /** Liveness ping on every node status change — re-arms the task inactivity
   *  watchdog, which milestone-only progress updates leave to expire. */
  readonly onLiveness?: () => void;
}

/** Aggregate result of a full supervisor execution run */
export interface SupervisorResult {
  readonly success: boolean;
  readonly output: string;
  readonly totalNodes: number;
  readonly succeeded: number;
  /**
   * Counts genuine failures and nodes that stopped to ask a question alike —
   * the aggregator folds blocked into this number. Read `blocked` beside it to
   * tell the two apart; they call for opposite responses.
   */
  readonly failed: number;
  /** Nodes that stopped on a question rather than an error. */
  readonly blocked: number;
  readonly skipped: number;
  readonly totalCost: number;
  readonly totalDuration: number;
  readonly nodeResults: NodeResult[];
  readonly partial: boolean;
}
