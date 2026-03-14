/**
 * Goal Renderer
 *
 * ASCII tree visualization for goal trees.
 * Produces monospace-safe output with status icons, hierarchy indentation,
 * progress bar header, duration for completed nodes, braille spinner for
 * executing nodes, parallelizable annotations, and truncation for large trees.
 * Works across all channels (web, Telegram, Discord, Slack, CLI).
 */

import type { GoalTree, GoalNode, GoalNodeId, GoalStatus } from "./types.js";
import { calculateProgress, renderProgressBar } from "./goal-progress.js";
import { renderGoalTreeMermaid, getMermaidInkUrl, wrapMermaidForWeb } from "../visualization/mermaid-renderer.js";

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

/** Escape HTML-sensitive characters in task text (defense-in-depth for web channels) */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Braille spinner characters for executing nodes */
const SPINNER_CHARS = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];

// =============================================================================
// OPTIONS
// =============================================================================

/** Options for customizing goal tree rendering */
export interface GoalRendererOptions {
  /** When true, annotates parallelizable nodes (for when parallel execution is disabled) */
  annotateParallelizable?: boolean;
  /** Output format: "ascii" (default) or "mermaid" (flowchart diagram) */
  format?: "ascii" | "mermaid";
  /** Channel type hint for format-specific output (e.g., "web" for inline mermaid) */
  channelType?: string;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Render a GoalTree as an ASCII tree with status icons.
 * Includes progress bar header for trees with sub-goals.
 * Shows duration for completed nodes and spinner for executing nodes.
 * Truncates output to MAX_RENDER_LENGTH with summary if exceeded.
 */
export function renderGoalTree(tree: GoalTree, options?: GoalRendererOptions): string {
  // Mermaid format: return flowchart diagram
  if (options?.format === "mermaid") {
    const mermaid = renderGoalTreeMermaid(tree);
    return options.channelType === "web"
      ? wrapMermaidForWeb(mermaid)
      : getMermaidInkUrl(mermaid);
  }

  const root = tree.nodes.get(tree.rootId);
  if (!root) return "(empty tree)";

  const lines: string[] = [];

  // Render root line
  lines.push(`${STATUS_ICONS[root.status]} ${escapeHtml(root.task)}`);

  // Find and sort root's children
  const children = getChildren(tree, tree.rootId);

  // Progress bar header (only for trees with sub-goals)
  if (children.length > 0) {
    const progress = calculateProgress(tree);
    lines.push(renderProgressBar(progress.completed, progress.total));
  }

  // Pre-compute parallelizable node IDs if annotation is requested
  let parallelizableIds: Set<GoalNodeId> | undefined;
  if (options?.annotateParallelizable) {
    const completedIds = new Set<GoalNodeId>();
    for (const [id, node] of tree.nodes) {
      if (node.status === "completed" || id === tree.rootId) completedIds.add(id);
    }
    const readyNodes: GoalNodeId[] = [];
    for (const [id, node] of tree.nodes) {
      if (id === tree.rootId) continue;
      if (node.status === "pending" && node.dependsOn.every(dep => completedIds.has(dep))) {
        readyNodes.push(id);
      }
    }
    if (readyNodes.length >= 2) {
      parallelizableIds = new Set(readyNodes);
    }
  }

  // Render each child recursively
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const isLast = i === children.length - 1;
    renderNode(tree, child.id, "", isLast, lines, parallelizableIds);
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
 * Shows duration for completed nodes and braille spinner for executing nodes.
 */
function renderNode(
  tree: GoalTree,
  nodeId: GoalNodeId,
  prefix: string,
  isLast: boolean,
  lines: string[],
  parallelizableIds?: Set<GoalNodeId>,
): void {
  const node = tree.nodes.get(nodeId);
  if (!node) return;

  const connector = isLast ? "\\-- " : "+-- ";
  let line = `${prefix}${connector}${STATUS_ICONS[node.status]} ${escapeHtml(node.task)}`;

  // Duration for completed nodes with timing
  if (node.status === "completed" && node.startedAt && node.completedAt) {
    const durationMs = node.completedAt - node.startedAt;
    const durationStr = durationMs < 1000
      ? `${durationMs}ms`
      : `${(durationMs / 1000).toFixed(1)}s`;
    line += ` (${durationStr})`;
  }

  // Braille spinner for executing nodes
  if (node.status === "executing") {
    const spinIdx = Math.floor(Date.now() / 100) % SPINNER_CHARS.length;
    line += ` ${SPINNER_CHARS[spinIdx]}`;
  }

  // Parallelizable annotation
  if (parallelizableIds?.has(nodeId)) {
    line += " (parallelizable)";
  }

  lines.push(line);

  const childPrefix = prefix + (isLast ? "    " : "|   ");
  const children = getChildren(tree, nodeId);

  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const childIsLast = i === children.length - 1;
    renderNode(tree, child.id, childPrefix, childIsLast, lines, parallelizableIds);
  }
}
