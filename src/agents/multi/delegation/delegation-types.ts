/**
 * Delegation Type System
 *
 * Core types, interfaces, and constants for the task delegation subsystem.
 * All delegation modules import from this file for consistent contracts.
 *
 * Requirements: AGENT-03, AGENT-04, AGENT-05
 */

import type { AgentId } from "../agent-types.js";
import type { ToolContext } from "../../tools/tool-core.interface.js";

// =============================================================================
// CORE TYPES
// =============================================================================

/** Model tier for delegation routing */
export type ModelTier = "local" | "cheap" | "standard" | "premium";

/** Delegation execution mode */
export type DelegationMode = "sync" | "async";

/** Delegation lifecycle status */
export type DelegationStatus = "running" | "completed" | "failed" | "timeout" | "cancelled";

// =============================================================================
// CONFIG INTERFACES
// =============================================================================

/** Configuration for a single delegation type */
export interface DelegationTypeConfig {
  readonly name: string;
  readonly tier: ModelTier;
  readonly timeoutMs: number;
  readonly maxIterations: number;
  readonly systemPrompt?: string;
}

/** Top-level delegation subsystem configuration */
export interface DelegationConfig {
  readonly enabled: boolean;
  readonly maxDepth: number;
  readonly maxConcurrentPerParent: number;
  readonly tiers: Record<ModelTier, string>;
  readonly types: DelegationTypeConfig[];
  readonly verbosity: "quiet" | "normal" | "verbose";
}

// =============================================================================
// REQUEST / RESULT
// =============================================================================

/** Request from parent agent to delegate a task */
export interface DelegationRequest {
  readonly type: string;
  readonly task: string;
  readonly context?: string;
  readonly parentAgentId: AgentId;
  readonly depth: number;
  readonly mode: DelegationMode;
  readonly toolContext: ToolContext;
}

/** Result returned by a sub-agent after delegation completes */
export interface DelegationResult {
  readonly content: string;
  readonly metadata: {
    readonly model: string;
    readonly tier: ModelTier;
    readonly costUsd: number;
    readonly durationMs: number;
    readonly toolsUsed: string[];
    readonly escalated: boolean;
    readonly escalatedFrom?: ModelTier;
  };
}

// =============================================================================
// EVENT PAYLOAD TYPES
// =============================================================================

/** Emitted when a delegation starts */
export interface DelegationStartedEvent {
  readonly parentAgentId: AgentId;
  readonly subAgentId: string;
  readonly type: string;
  readonly tier: ModelTier;
  readonly model: string;
  readonly depth: number;
  readonly mode: DelegationMode;
  readonly timestamp: number;
}

/** Emitted when a delegation completes (success or failure) */
export interface DelegationCompletedEvent {
  readonly parentAgentId: AgentId;
  readonly subAgentId: string;
  readonly type: string;
  readonly tier: ModelTier;
  readonly model: string;
  readonly success: boolean;
  readonly durationMs: number;
  readonly costUsd: number;
  readonly escalated: boolean;
  readonly timestamp: number;
}

/** Emitted when a delegation fails */
export interface DelegationFailedEvent {
  readonly parentAgentId: AgentId;
  readonly subAgentId: string;
  readonly type: string;
  readonly reason: string;
  /** The original tier that triggered escalation, if this failure occurred during an escalation attempt */
  readonly originalTier?: ModelTier;
  readonly timestamp: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Built-in delegation types with sensible defaults */
export const DEFAULT_DELEGATION_TYPES: readonly DelegationTypeConfig[] = [
  { name: "code_review", tier: "cheap", timeoutMs: 60000, maxIterations: 10 },
  { name: "documentation", tier: "cheap", timeoutMs: 45000, maxIterations: 8 },
  { name: "analysis", tier: "standard", timeoutMs: 90000, maxIterations: 15 },
  { name: "implementation", tier: "standard", timeoutMs: 120000, maxIterations: 20 },
] as const;

/**
 * Escalation chain for tier upgrades.
 * Local is excluded per user decision (local models cannot escalate).
 */
export const ESCALATION_CHAIN = ["cheap", "standard", "premium"] as const;
