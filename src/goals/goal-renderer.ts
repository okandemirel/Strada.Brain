/**
 * Goal Renderer
 *
 * ASCII tree visualization for goal trees.
 * Produces monospace-safe output with status icons, hierarchy indentation,
 * and truncation for large trees. Works across all channels (web, Telegram,
 * Discord, Slack, CLI).
 */

import type { GoalTree, GoalNode, GoalNodeId, GoalStatus } from "./types.js";

// =============================================================================
// STATUS ICONS
// =============================================================================

const STATUS_ICONS: Record<GoalStatus, string> = {
  pending: "[ ]",
  executing: "[~]",
  completed: "[x]",
  failed: "[!]",
  skipped: "[-]",
};

/** Maximum character length before truncation */
const MAX_RENDER_LENGTH = 3000;

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Render a GoalTree as an ASCII tree with status icons.
 * Truncates output to MAX_RENDER_LENGTH with summary if exceeded.
 */
export function renderGoalTree(tree: GoalTree): string {
  const root = tree.nodes.get(tree.rootId);
  if (!root) return "(empty tree)";

  const lines: string[] = [];

  // Render root line
  lines.push(`${STATUS_ICONS[root.status]} ${root.task}`);

  // Find and sort root's children
  const children = getChildren(tree, tree.rootId);

  // Render each child recursively
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const isLast = i === children.length - 1;
    renderNode(tree, child.id, "", isLast, lines);
  }

  let output = lines.join("\n");

  // Truncate if too long
  if (output.length > MAX_RENDER_LENGTH) {
    const summary = summarizeTree(tree);
    output = output.slice(0, MAX_RENDER_LENGTH - 100);
    // Cut to last complete line
    const lastNewline = output.lastIndexOf("\n");
    if (lastNewline > 0) {
      output = output.slice(0, lastNewline);
    }
    output += `\n...\n${summary}\n(Full tree available via /api/goals)`;
  }

  return output;
}

/**
 * Summarize a GoalTree as a one-line status count string.
 * Excludes the root node from counts.
 * Omits zero-count statuses.
 */
export function summarizeTree(tree: GoalTree): string {
  let completed = 0;
  let executing = 0;
  let pending = 0;
  let failed = 0;
  let skipped = 0;
  let total = 0;

  for (const [id, node] of tree.nodes) {
    if (id === tree.rootId) continue; // exclude root
    total++;
    switch (node.status) {
      case "completed": completed++; break;
      case "executing": executing++; break;
      case "pending": pending++; break;
      case "failed": failed++; break;
      case "skipped": skipped++; break;
    }
  }

  const parts: string[] = [];
  if (completed > 0) parts.push(`${completed} complete`);
  if (executing > 0) parts.push(`${executing} running`);
  if (pending > 0) parts.push(`${pending} pending`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);

  return `${total} sub-goals: ${parts.join(", ")}`;
}

// =============================================================================
// PRIVATE HELPERS
// =============================================================================

/** Get children of a node, sorted by createdAt */
function getChildren(tree: GoalTree, parentId: GoalNodeId): GoalNode[] {
  const children: GoalNode[] = [];
  for (const [, node] of tree.nodes) {
    if (node.parentId === parentId) {
      children.push(node);
    }
  }
  return children.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Recursively render a node with proper indentation.
 * Uses box-drawing characters: +-- for non-last, \-- for last child,
 * |   for continuation, spaces for last-child continuation.
 */
function renderNode(
  tree: GoalTree,
  nodeId: GoalNodeId,
  prefix: string,
  isLast: boolean,
  lines: string[],
): void {
  const node = tree.nodes.get(nodeId);
  if (!node) return;

  const connector = isLast ? "\\-- " : "+-- ";
  lines.push(`${prefix}${connector}${STATUS_ICONS[node.status]} ${node.task}`);

  const childPrefix = prefix + (isLast ? "    " : "|   ");
  const children = getChildren(tree, nodeId);

  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const childIsLast = i === children.length - 1;
    renderNode(tree, child.id, childPrefix, childIsLast, lines);
  }
}
