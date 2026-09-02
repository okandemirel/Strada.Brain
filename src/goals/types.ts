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

/**
 * Monitor-mode review column state (additive; does not replace GoalStatus).
 *
 * audited 2026-09-02: this is HUMAN-driven display state. The only writers of
 * a value other than "none" are a person dragging a Kanban card or approving
 * a gate in the web portal (dashboard/workspace-runtime-bridge.ts); no backend
 * path advances it and nothing gates completion on it. Machine verification of
 * a node is the supervisor's cross-provider verifier, which acts on `status`.
 */
export type ReviewStatus = "none" | "spec_review" | "quality_review" | "review_passed" | "review_stuck";

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
  readonly redecompositionCount?: number;
  readonly reviewStatus?: ReviewStatus;
  readonly reviewIterations?: number;
}

/** A goal tree rooted at a single node */
export interface GoalTree {
  readonly rootId: GoalNodeId;
  readonly sessionId: string;
  readonly taskDescription: string;
  readonly nodes: ReadonlyMap<GoalNodeId, GoalNode>;
  readonly createdAt: number;
  readonly planSummary?: string;
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
// =============================================================================
// GOAL BLOCK OUTPUT (Phase 16: Interactive Goal Execution)
// =============================================================================

/** Structure returned by LLM when it identifies a user request as a goal */
export interface GoalBlockOutput {
  isGoal: boolean;
  estimatedMinutes: number;
  nodes: Array<{
    id: string;
    task: string;
    dependsOn: string[];
  }>;
}

/**
 * Build a GoalTree from a GoalBlockOutput (shared factory).
 * Used by both orchestrator (inline goal detection) and any future callers.
 */
export function buildGoalTreeFromBlock(
  goalBlock: GoalBlockOutput,
  sessionId: string,
  taskDescription: string,
  planSummary?: string,
): GoalTree {
  const rootId = generateGoalNodeId();
  const now = Date.now();
  const nodes = new Map<GoalNodeId, GoalNode>();
  nodes.set(rootId, {
    id: rootId, parentId: null, task: taskDescription,
    dependsOn: [], depth: 0, status: "pending", createdAt: now, updatedAt: now,
  });
  const idMap = new Map<string, GoalNodeId>();
  for (const n of goalBlock.nodes) { idMap.set(n.id, generateGoalNodeId()); }
  for (const n of goalBlock.nodes) {
    const nodeId = idMap.get(n.id)!;
    nodes.set(nodeId, {
      id: nodeId, parentId: rootId, task: n.task,
      dependsOn: n.dependsOn.map(d => idMap.get(d)).filter((d): d is GoalNodeId => !!d),
      depth: 1, status: "pending", createdAt: now, updatedAt: now,
    });
  }
  return {
    rootId, sessionId, taskDescription,
    planSummary: planSummary?.slice(0, 4096),
    nodes, createdAt: now,
  };
}

const goalBlockNodeSchema = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  dependsOn: z.array(z.string().max(64)).max(20).default([]),
});

/** Zod schema for validating GoalBlockOutput from LLM responses */
export const goalBlockSchema = z.object({
  isGoal: z.boolean(),
  estimatedMinutes: z.number().positive().max(1440),
  nodes: z.array(goalBlockNodeSchema).min(1).max(20),
});

/**
 * Parse a goal block from LLM text output.
 * Extracts triple-backtick goal fenced blocks (```goal ... ```),
 * strips fences, parses JSON, and validates with Zod.
 * Returns null on any failure (no goal block, invalid JSON, schema mismatch).
 */
export function parseGoalBlock(text: string): GoalBlockOutput | null {
  try {
    const fenceMatch = text.match(/```goal\s*\n([\s\S]*?)\n\s*```/);
    if (!fenceMatch?.[1]) {
      return null;
    }

    const cleaned = fenceMatch[1].trim();
    const parsed = JSON.parse(cleaned);
    const result = goalBlockSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
}

export function parseLLMOutput(text: string): LLMDecompositionOutput | null {
  try {
    let cleaned = text.trim();

    // 1. Strip <reasoning>...</reasoning> blocks (Kimi K2.5 embeds these)
    cleaned = cleaned.replace(/<reasoning>[\s\S]*?<\/reasoning>\s*/g, "").trim();

    // 2. Extract from markdown code fences anywhere in text (not just start/end)
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
    if (fenceMatch?.[1]) {
      cleaned = fenceMatch[1].trim();
    } else {
      // 3. Fallback: find first JSON object in text
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        cleaned = jsonMatch[0];
      }
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

// audited 2026-09-02: the "review pipeline helpers" that lived here
// (`isNodeTrulyDone`, `getNextReviewStatus`) had no production caller — the
// planned GoalExecutor enforcement was never built and that file is gone. A
// gate nothing calls reads as enforcement, so the helpers were removed rather
// than left advertising a check that never ran. Node verification is done by
// the supervisor's cross-provider verifier (supervisor/result-aggregator.ts),
// which rewrites `status`, not `reviewStatus`.
