/**
 * Goal Progress Tracking
 *
 * Calculates completion percentage for goal trees and renders
 * progress bars. Uses the leaf completion ratio (completed / total
 * work nodes: neither the root nor a scaffolding parent).
 */

import type { GoalNodeId, GoalTree } from "./types.js";

// =============================================================================
// TYPES
// =============================================================================

export interface ProgressInfo {
  completed: number;
  total: number;
  percentage: number;
}

// =============================================================================
// PROGRESS CALCULATION
// =============================================================================

/**
 * The nodes whose children carry their work. A scaffolding parent is never dispatched and
 * nothing marks it done (the same leaf rule as tree-shape.ts countDispatchableGoals), so its
 * state is its leaves' state, not a step of its own.
 */
export function scaffoldingNodeIds(tree: GoalTree): Set<GoalNodeId> {
  const parents = new Set<GoalNodeId>();
  for (const [, node] of tree.nodes) {
    if (node.parentId !== null && tree.nodes.has(node.parentId)) parents.add(node.parentId);
  }
  return parents;
}

/**
 * Calculate progress across the leaf (work) nodes of a goal tree: completed / total.
 * The root and scaffolding parents are not steps — counting them held a fully executed
 * plan at e.g. 3/4 (75%) with the finished parent as "current focus" (agent-core-goals#5).
 */
export function calculateProgress(tree: GoalTree): ProgressInfo {
  const scaffolding = scaffoldingNodeIds(tree);
  let completed = 0;
  let total = 0;
  for (const [id, node] of tree.nodes) {
    if (id === tree.rootId || scaffolding.has(id)) continue;
    total++;
    if (node.status === "completed") completed++;
  }
  const percentage = total === 0 ? 0 : Math.round((completed / total) * 100);
  return { completed, total, percentage };
}

// =============================================================================
// PROGRESS BAR RENDERING
// =============================================================================

/**
 * Render a progress bar in [######....] 3/5 (60%) format.
 * Per user decision: root-level progress indicator with bar + fraction + percentage.
 */
export function renderProgressBar(
  completed: number,
  total: number,
  width: number = 10,
): string {
  if (total === 0) return `[${".".repeat(width)}] 0/0 (0%)`;
  const pct = Math.round((completed / total) * 100);
  const filled = Math.round((completed / total) * width);
  const bar = "#".repeat(filled) + ".".repeat(width - filled);
  return `[${bar}] ${completed}/${total} (${pct}%)`;
}
