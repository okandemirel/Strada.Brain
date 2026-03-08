/**
 * Crash Recovery Context
 *
 * Builds recovery context after unclean shutdown detection.
 * Provides downtime duration, last activity, and interrupted goal trees
 * for system prompt injection so the LLM naturally acknowledges the crash.
 */

import type { IdentityState } from "./identity-state.js";
import type { GoalTree } from "../goals/types.js";

/**
 * Context available after an unclean shutdown is detected.
 * Injected into the system prompt for crash-aware LLM responses.
 */
export interface CrashRecoveryContext {
  wasCrash: true;
  downtimeMs: number;
  lastActivityTs: number;
  bootCount: number;
  interruptedTrees: GoalTree[];
}

/**
 * Build crash recovery context from identity state and interrupted trees.
 * Returns null for clean restarts (wasCrash=false).
 */
export function buildCrashRecoveryContext(
  wasCrash: boolean,
  identityState: IdentityState,
  interruptedTrees: GoalTree[],
): CrashRecoveryContext | null {
  if (!wasCrash) {
    return null;
  }

  const downtimeMs = Date.now() - identityState.lastActivityTs;

  return {
    wasCrash: true,
    downtimeMs,
    lastActivityTs: identityState.lastActivityTs,
    bootCount: identityState.bootCount,
    interruptedTrees,
  };
}

/**
 * Format a duration in milliseconds as human-readable text.
 * - < 60s: "less than a minute"
 * - < 1h: "X minute(s)"
 * - < 24h: "X hour(s) Y minute(s)"
 * - >= 24h: "X day(s) Y hour(s)"
 */
export function formatDowntime(ms: number): string {
  if (ms < 60000) {
    return "less than a minute";
  }

  const totalMinutes = Math.floor(ms / 60000);

  if (ms >= 86400000) {
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    return `${days} day${days !== 1 ? "s" : ""} ${hours} hour${hours !== 1 ? "s" : ""}`;
  }

  if (ms >= 3600000) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours} hour${hours !== 1 ? "s" : ""} ${minutes} minute${minutes !== 1 ? "s" : ""}`;
  }

  return `${totalMinutes} minute${totalMinutes !== 1 ? "s" : ""}`;
}
