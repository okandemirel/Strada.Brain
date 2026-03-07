/**
 * Goal DAG Validator
 *
 * Validates LLM decomposition output to ensure it forms a valid DAG:
 * 1. Checks for dangling dependsOn references (referencing non-existent nodes)
 * 2. Detects cycles using Kahn's algorithm (topological sort)
 * 3. Produces a topological order for execution scheduling
 */

import type { GoalNodeId, LLMDecompositionOutput } from "./types.js";

// =============================================================================
// TYPES
// =============================================================================

/** Result of DAG validation */
export interface DAGValidationResult {
  /** Whether the DAG is valid (acyclic, no dangling refs) */
  readonly valid: boolean;
  /** Topological execution order (only present when valid=true) */
  readonly topologicalOrder?: GoalNodeId[];
  /** Node IDs involved in a cycle (only present when valid=false due to cycle) */
  readonly cycleNodes?: string[];
  /** Dependency IDs that reference non-existent nodes (only when valid=false) */
  readonly danglingRefs?: string[];
}

// =============================================================================
// VALIDATOR
// =============================================================================

/**
 * Validate that a set of nodes forms a valid DAG.
 *
 * Steps:
 * 1. Check for dangling refs (dependsOn pointing to non-existent IDs)
 * 2. Build adjacency list and in-degree map
 * 3. Run Kahn's algorithm for topological sort
 * 4. If sorted count !== node count, cycle detected
 *
 * @param nodes - The nodes from LLM decomposition output
 * @param _maxDepth - Reserved for future depth enforcement
 * @returns Validation result with topological order or error details
 */
export function validateDAG(
  nodes: LLMDecompositionOutput["nodes"],
  _maxDepth?: number,
): DAGValidationResult {
  const nodeIds = new Set(nodes.map((n) => n.id));

  // 1. Check for dangling references
  const danglingRefs: string[] = [];
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!nodeIds.has(dep)) {
        danglingRefs.push(dep);
      }
    }
  }
  if (danglingRefs.length > 0) {
    return { valid: false, danglingRefs };
  }

  // 2. Build adjacency list (dep -> dependent) and in-degree map
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const node of nodes) {
    adjacency.set(node.id, []);
    inDegree.set(node.id, 0);
  }

  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      adjacency.get(dep)!.push(node.id);
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
    }
  }

  // 3. Kahn's algorithm: start with zero in-degree nodes
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  const order: GoalNodeId[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current as GoalNodeId);

    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  // 4. If not all nodes processed, cycle exists
  if (order.length !== nodes.length) {
    const visited = new Set(order.map((id) => id as string));
    const cycleNodes = nodes
      .filter((n) => !visited.has(n.id))
      .map((n) => n.id);
    return { valid: false, cycleNodes };
  }

  return { valid: true, topologicalOrder: order };
}
