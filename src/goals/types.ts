/**
 * Goal Decomposition Types
 *
 * Core type definitions for recursive goal decomposition.
 * Defines GoalNode DAG with dependsOn edges, GoalTree, and Zod-validated
 * LLM output schema for sub-goal generation.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";

// =============================================================================
// BRANDED TYPES
// =============================================================================

/** Goal node identifier (branded for type safety) */
export type GoalNodeId = string & { readonly __brand: "GoalNodeId" };

/** Generate a unique GoalNodeId */
export function generateGoalNodeId(): GoalNodeId {
  return `goal_${Date.now()}_${randomBytes(4).toString("hex")}` as GoalNodeId;
}

// =============================================================================
// STATUS
// =============================================================================

/** Lifecycle status of a goal node */
export type GoalStatus = "pending" | "executing" | "completed" | "failed" | "skipped";

// =============================================================================
// GOAL NODE & TREE
// =============================================================================

/** A single node in the goal DAG */
export interface GoalNode {
  readonly id: GoalNodeId;
  readonly parentId: GoalNodeId | null;
  readonly task: string;
  readonly dependsOn: readonly GoalNodeId[];
  readonly depth: number;
  readonly status: GoalStatus;
  readonly result?: string;
  readonly error?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly retryCount?: number;
}

/** A goal tree rooted at a single node */
export interface GoalTree {
  readonly rootId: GoalNodeId;
  readonly sessionId: string;
  readonly taskDescription: string;
  readonly nodes: ReadonlyMap<GoalNodeId, GoalNode>;
  readonly createdAt: number;
}

// =============================================================================
// LLM DECOMPOSITION OUTPUT
// =============================================================================

/** Structure returned by LLM for sub-goal generation */
export interface LLMDecompositionOutput {
  nodes: Array<{
    id: string;
    task: string;
    dependsOn: string[];
    needsFurtherDecomposition?: boolean;
  }>;
}

/** Lifecycle event emitted when a goal node changes status */
export interface GoalLifecycleEvent {
  readonly rootId: GoalNodeId;
  readonly nodeId: GoalNodeId;
  readonly status: GoalStatus;
  readonly depth: number;
  readonly timestamp: number;
}

// =============================================================================
// ZOD SCHEMA FOR LLM OUTPUT VALIDATION
// =============================================================================

const nodeSchema = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  needsFurtherDecomposition: z.boolean().optional(),
});

/** Zod schema for validating LLM decomposition output */
export const llmDecompositionSchema = z.object({
  nodes: z.array(nodeSchema).min(1).max(20),
});

// =============================================================================
// PARSER
// =============================================================================

/**
 * Parse LLM text output into a validated LLMDecompositionOutput.
 * Strips markdown code fences, parses JSON, and validates with Zod.
 * Returns null on any failure (invalid JSON, schema mismatch, etc.).
 */
export function parseLLMOutput(text: string): LLMDecompositionOutput | null {
  try {
    // Strip markdown code fences (```json ... ``` or ``` ... ```)
    let cleaned = text.trim();
    const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }

    const parsed = JSON.parse(cleaned);
    const result = llmDecompositionSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
}
