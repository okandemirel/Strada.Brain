/**
 * Supervisor Brain - Shared Types
 *
 * Core type definitions for the multi-provider supervisor orchestration layer.
 * Defines capability tagging, node results, verification, and configuration.
 *
 * All interfaces use readonly fields for immutability.
 */

import type { GoalNode, GoalNodeId } from "../goals/types.js";
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
  readonly status: "ok" | "failed" | "skipped";
  readonly output: string;
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

/** Verdict from cross-provider verification of a node result */
export interface VerificationVerdict {
  readonly verdict: "approve" | "flag_issues" | "reject";
  readonly issues?: string[];
  readonly verifierProvider: string;
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
export interface SupervisorContext {
  readonly chatId: string;
  readonly userId?: string;
  readonly conversationId?: string;
  readonly signal?: AbortSignal;
}

/** Aggregate result of a full supervisor execution run */
export interface SupervisorResult {
  readonly success: boolean;
  readonly output: string;
  readonly totalNodes: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly totalCost: number;
  readonly totalDuration: number;
  readonly nodeResults: NodeResult[];
  readonly partial: boolean;
}
