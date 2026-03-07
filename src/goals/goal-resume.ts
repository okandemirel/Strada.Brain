/**
 * Goal Resume
 *
 * Detects interrupted goal trees (status = 'executing' in GoalStorage)
 * and prepares them for smart resume. Nodes stuck in 'executing' status
 * are reset to 'pending' for re-execution; completed nodes are preserved.
 */

import type { GoalStorage } from "./goal-storage.js";
import type { GoalTree, GoalNode, GoalNodeId } from "./types.js";
import { renderGoalTree } from "./goal-renderer.js";
import { calculateProgress, renderProgressBar } from "./goal-progress.js";

/** Staleness threshold: 24 hours in milliseconds */
const STALENESS_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Detect interrupted goal trees from storage.
 * Returns trees that were mid-execution when the process stopped.
 */
export function detectInterruptedTrees(goalStorage: GoalStorage): GoalTree[] {
  return goalStorage.getInterruptedTrees();
}

/**
 * Prepare an interrupted tree for resume by resetting 'executing' nodes to 'pending'.
 * Completed nodes are preserved (smart resume -- don't re-do finished work).
 * Failed nodes are preserved (user can see what failed before deciding).
 * Returns a new tree with updated nodes (immutable pattern).
 */
export function prepareTreeForResume(tree: GoalTree): GoalTree {
  const mutableNodes = new Map<GoalNodeId, GoalNode>();
  for (const [id, node] of tree.nodes) {
    if (node.status === "executing") {
      // Reset executing nodes to pending for re-execution
      mutableNodes.set(id, {
        ...node,
        status: "pending" as const,
        startedAt: undefined,
        completedAt: undefined,
        updatedAt: Date.now(),
      });
    } else {
      mutableNodes.set(id, node);
    }
  }
  return { ...tree, nodes: mutableNodes };
}

/**
 * Check if a tree is stale (older than 24 hours since last update).
 */
export function isTreeStale(tree: GoalTree): boolean {
  let latestUpdate = tree.createdAt;
  for (const [, node] of tree.nodes) {
    if (node.updatedAt > latestUpdate) latestUpdate = node.updatedAt;
  }
  return Date.now() - latestUpdate > STALENESS_THRESHOLD_MS;
}

/**
 * Format a resume prompt for the user listing all interrupted trees.
 * Shows full ASCII tree with status icons, progress bar, and Resume/Discard options.
 */
export function formatResumePrompt(trees: GoalTree[]): string {
  if (trees.length === 0) return "";

  const lines: string[] = [
    `Found ${trees.length} interrupted goal tree${trees.length > 1 ? "s" : ""}:`,
    "",
  ];

  for (let i = 0; i < trees.length; i++) {
    const tree = trees[i]!;
    const prepared = prepareTreeForResume(tree);
    const progress = calculateProgress(prepared);
    const stale = isTreeStale(tree);

    lines.push(`--- Tree ${i + 1}: ${tree.taskDescription} ---`);
    lines.push(renderProgressBar(progress.completed, progress.total));
    lines.push(renderGoalTree(prepared));
    if (stale) {
      lines.push("(This tree is over 24 hours old -- consider discarding)");
    }
    lines.push("");
  }

  if (trees.length === 1) {
    lines.push('Reply "Resume" to continue or "Discard" to abandon.');
  } else {
    lines.push('Reply "Resume all", "Resume #N", or "Discard all".');
  }

  return lines.join("\n");
}
