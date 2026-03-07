/**
 * Goal Progress Tracking
 *
 * Calculates completion percentage for goal trees and renders
 * progress bars. Uses simple child completion ratio (completed / total
 * non-root nodes) per user discretion.
 */

import type { GoalTree } from "./types.js";

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
 * Calculate progress across all non-root nodes in a goal tree.
 * Simple child completion ratio: completed / total non-root nodes.
 */
export function calculateProgress(tree: GoalTree): ProgressInfo {
  let completed = 0;
  let total = 0;
  for (const [id, node] of tree.nodes) {
    if (id === tree.rootId) continue;
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
