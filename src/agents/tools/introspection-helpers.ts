/**
 * Shared helpers for introspection tools.
 *
 * Provides:
 * - Markdown section builder (consistent formatting)
 * - Per-tool rate limiting (simple sliding-window)
 * - Auth guard (checks ToolContext.userId)
 */

import type { ToolExecutionResult } from "./tool.interface.js";

// ============================================================================
// Markdown Section Builder
// ============================================================================

/** Build a markdown section with a heading and bullet-point items. */
export function buildSection(heading: string, items: string[]): string {
  return [`## ${heading}`, ...items.map((i) => `- ${i}`)].join("\n");
}

/** Placeholder section for unavailable data. */
export function unavailableSection(heading: string, reason: string): string {
  return `## ${heading}\n\nNot available (${reason}).`;
}

// ============================================================================
// Per-Tool Rate Limiting
// ============================================================================

const toolCallTimestamps = new Map<string, number[]>();

const INTROSPECTION_RATE_LIMIT = 10; // max calls per window
const INTROSPECTION_WINDOW_MS = 60_000; // 1 minute

/**
 * Check whether a tool call is allowed under the per-tool rate limit.
 * Returns an error result if rate-limited, or undefined if allowed.
 */
export function checkToolRateLimit(toolName: string): ToolExecutionResult | undefined {
  const now = Date.now();
  const cutoff = now - INTROSPECTION_WINDOW_MS;

  let timestamps = toolCallTimestamps.get(toolName);
  if (!timestamps) {
    timestamps = [];
    toolCallTimestamps.set(toolName, timestamps);
  }

  // Prune expired entries
  const pruned = timestamps.filter((t) => t > cutoff);
  toolCallTimestamps.set(toolName, pruned);

  if (pruned.length >= INTROSPECTION_RATE_LIMIT) {
    return {
      content: `Rate limited: ${toolName} can be called at most ${INTROSPECTION_RATE_LIMIT} times per minute.`,
      isError: true,
    };
  }

  pruned.push(now);
  return undefined;
}

/**
 * Reset rate limit state for a specific tool (used in tests).
 */
export function resetToolRateLimit(toolName: string): void {
  toolCallTimestamps.delete(toolName);
}
