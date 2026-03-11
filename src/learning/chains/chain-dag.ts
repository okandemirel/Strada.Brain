/**
 * Chain DAG Validator
 *
 * Validates chain step definitions form a valid DAG:
 * 1. Checks for dangling dependsOn references (non-existent stepIds)
 * 2. Detects cycles using Kahn's algorithm (topological sort)
 * 3. Produces a topological order for execution scheduling
 * 4. Computes execution waves (groups of independent steps that can run in parallel)
 *
 * Pattern reference: src/goals/goal-validator.ts (same Kahn's algorithm)
 */

import type { ChainStepNode } from "./chain-types.js";

// =============================================================================
// TYPES
// =============================================================================

/** Result of chain DAG validation */
export interface ChainDAGValidationResult {
  /** Whether the DAG is valid (acyclic, no dangling refs) */
  readonly valid: boolean;
  /** Topological execution order (only present when valid=true) */
  readonly topologicalOrder?: string[];
  /** Step IDs involved in a cycle (only present when valid=false due to cycle) */
  readonly cycleNodes?: string[];
  /** Dependency IDs that reference non-existent steps (only when valid=false) */
  readonly danglingRefs?: string[];
}

// =============================================================================
// DAG VALIDATION
// =============================================================================

/**
 * Validate that a set of chain steps forms a valid DAG.
 *
 * Steps:
 * 1. Check for dangling refs (dependsOn pointing to non-existent stepIds)
 * 2. Build adjacency list and in-degree map
 * 3. Run Kahn's algorithm for topological sort
 * 4. If sorted count !== step count, cycle detected
 */
export function validateChainDAG(steps: ChainStepNode[]): ChainDAGValidationResult {
  const stepIds = new Set(steps.map((s) => s.stepId));

  // 1. Check for dangling references
  const danglingRefs: string[] = [];
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!stepIds.has(dep)) {
        danglingRefs.push(dep);
      }
    }
  }
  if (danglingRefs.length > 0) {
    return { valid: false, danglingRefs };
  }

  // 2. Build adjacency list (dependency -> dependents) and in-degree map
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const step of steps) {
    adjacency.set(step.stepId, []);
    inDegree.set(step.stepId, 0);
  }

  for (const step of steps) {
    for (const dep of step.dependsOn) {
      adjacency.get(dep)!.push(step.stepId);
      inDegree.set(step.stepId, (inDegree.get(step.stepId) ?? 0) + 1);
    }
  }

  // 3. Kahn's algorithm: start with zero in-degree nodes
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);

    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  // 4. If not all steps processed, cycle exists
  if (order.length !== steps.length) {
    const visited = new Set(order);
    const cycleNodes = steps
      .filter((s) => !visited.has(s.stepId))
      .map((s) => s.stepId);
    return { valid: false, cycleNodes };
  }

  return { valid: true, topologicalOrder: order };
}

// =============================================================================
// WAVE COMPUTATION
// =============================================================================

/**
 * Compute execution waves from chain steps.
 *
 * Each wave contains steps that can execute in parallel (all dependencies
 * are in earlier waves). Steps are grouped by their "depth" in the DAG:
 * - Root nodes (no deps): depth 0
 * - Other nodes: max(depth of deps) + 1
 *
 * @throws Error if the DAG is invalid (cycle or dangling refs)
 */
export function computeChainWaves(steps: ChainStepNode[]): ChainStepNode[][] {
  const validation = validateChainDAG(steps);
  if (!validation.valid) {
    throw new Error(
      `Invalid chain DAG: ${validation.cycleNodes ? `cycle detected in [${validation.cycleNodes.join(", ")}]` : `dangling refs [${validation.danglingRefs?.join(", ")}]`}`,
    );
  }

  // Build step lookup
  const stepMap = new Map<string, ChainStepNode>();
  for (const step of steps) {
    stepMap.set(step.stepId, step);
  }

  // Compute depth for each step
  const depth = new Map<string, number>();

  function getDepth(stepId: string): number {
    if (depth.has(stepId)) return depth.get(stepId)!;

    const step = stepMap.get(stepId)!;
    if (step.dependsOn.length === 0) {
      depth.set(stepId, 0);
      return 0;
    }

    const maxDepDep = Math.max(...step.dependsOn.map((dep) => getDepth(dep)));
    const d = maxDepDep + 1;
    depth.set(stepId, d);
    return d;
  }

  for (const step of steps) {
    getDepth(step.stepId);
  }

  // Group by depth into waves
  const maxDepth = Math.max(...Array.from(depth.values()));
  const waves: ChainStepNode[][] = [];
  for (let d = 0; d <= maxDepth; d++) {
    waves.push([]);
  }

  for (const step of steps) {
    const d = depth.get(step.stepId)!;
    waves[d]!.push(step);
  }

  return waves;
}
