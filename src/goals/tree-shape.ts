/**
 * Whether a decomposed tree is worth the supervisor.
 *
 * The decomposition prompt tells the model to return a single-node tree when a
 * task does not need splitting, and it does. Nothing read that answer: an
 * incoming goal tree forced the supervisor path unconditionally
 * (`shouldForceSupervisor = Boolean(params.goalTree)`), so a one-goal tree still
 * bought capability triage, a node runner and a cross-provider verification call
 * per node — the whole apparatus, to run one agent loop.
 *
 * The escape hatch existed in the prompt and not in the code. This reads it.
 */

import type { GoalTree } from "./types.js";

/**
 * Count the goals a tree would actually dispatch.
 *
 * A parent whose children carry the work is scaffolding, not a unit of work, so
 * only leaves count. A tree of one node is one leaf and one unit of work.
 */
export function countDispatchableGoals(tree: GoalTree): number {
  const withChildren = new Set<string>();
  for (const [, node] of tree.nodes) {
    if (node.parentId !== null) withChildren.add(node.parentId);
  }

  let leaves = 0;
  for (const [id] of tree.nodes) {
    if (!withChildren.has(id)) leaves++;
  }
  return leaves;
}

/**
 * Does this tree describe more than one piece of work?
 *
 * Only a tree that does can justify the supervisor: parallelism across one goal
 * is not parallelism, and every stage the supervisor adds — triage, per-node
 * dispatch, per-node verification — is paid per run whether or not there is
 * anything to coordinate.
 */
export function warrantsSupervisor(tree: GoalTree | undefined): boolean {
  if (!tree) return false;
  return countDispatchableGoals(tree) > 1;
}
