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

/** Verbs that change the project or produce an artifact — anywhere in the task text. */
const WORK_RE =
  /\b(create|generate|draw|paint|write|bind|place|instantiate|implement|add|replace|fix|build|import|compose|record|configure|wire|assemble|edit|update|refactor|remove|delete|rename|migrate|convert|apply|set up|setup|install|execute|verify|capture|deliver|produce|ship|author|animate|script|attach|spawn|hook up|populate|tune|polish|export|commit|register|integrate)\b/i;
/**
 * Verbs that only look — judged on the task's LEADING verb, so "Read the GDD
 * and generate the sprites" is work (generate) while "Read PixelFlow_GDD.md
 * structure and extract key requirements" is looking. Review 2026-09-08:
 * "extract", "map", "document", "inspect", "locate", "find" are also how
 * real work is phrased ("Extract the movement logic into MovementBase",
 * "Map legacy enemy IDs to the new enum"), so they are neither list —
 * neutral nodes are never counted as exploration.
 */
const EXPLORATION_LEAD_RE =
  /^\W*(?:\d+[.)]\s*)?(explore|vault_search|search|read|analy[sz]e|inventory|list|review|understand|survey|audit|examine|scan|grep|look|gather|collect|catalog)\b/i;

export interface PlanShapeVerdict {
  /** True when the plan has 2+ nodes and every one of them only looks. */
  readonly explorationOnly: boolean;
  readonly workNodes: number;
  readonly explorationNodes: number;
}

/**
 * Whether a plan is all looking and no doing.
 *
 * Measured 2026-09-08 08:21-08:48 (PixelFlow, a sprint whose prompt said
 * "DO NOT AUDIT"): the planner answered with seven nodes — "vault_search for
 * GDD files", "vault_search for module definitions", "… scene files", "…
 * prefab files", "… audio assets", "… existing patterns", "Read
 * PixelFlow_GDD.md structure" — and the sprint spent thirty minutes and 55
 * read calls producing nothing. A single-node tree is the whole task and is
 * not judged here.
 */
export function judgePlanShape(nodes: ReadonlyArray<{ readonly task: string }>): PlanShapeVerdict {
  let workNodes = 0;
  let explorationNodes = 0;
  for (const node of nodes) {
    if (WORK_RE.test(node.task)) workNodes++;
    else if (EXPLORATION_LEAD_RE.test(node.task)) explorationNodes++;
  }
  // Every node must POSITIVELY be exploration: a plan of neutral labels
  // ("Step 1", "Task A", "Extract X into Y") says nothing about its shape.
  return {
    explorationOnly: nodes.length >= 2 && workNodes === 0 && explorationNodes === nodes.length,
    workNodes,
    explorationNodes,
  };
}
