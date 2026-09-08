/**
 * One log line per model call, wherever the call is made.
 *
 * The FallbackChain logs its own calls, but the agent loop calls a
 * hard-pinned member's chatStream DIRECTLY (provider-manager.getProvider
 * returns the bare member for a hard pin), so the sprint's actual turns
 * left no line at all — measured 2026-09-07 20:47: 24 tool calls, one
 * "Provider call" (the decomposition). The turn cost is the number the
 * user asked for; it has to be measured at the call site the loop uses.
 */

import type { IAIProvider, ProviderResponse } from "./provider.interface.js";
import { getLogger } from "../../utils/logger.js";

/**
 * How much of the request the tool schemas are. Measured 2026-09-08 03:40
 * on a PixelFlow sprint turn: 121k prompt chars + 104 tools = 57-64k input
 * tokens, and the prompt alone accounts for roughly 30k of them — the rest
 * is tools and messages, and only a measurement says which.
 */
export function toolDefinitionChars(tools: ReadonlyArray<unknown> | undefined): number {
  if (!tools || tools.length === 0) return 0;
  return JSON.stringify(tools).length;
}

/**
 * The measured pace of the agent loop's turns, newest TURN_PACE_WINDOW.
 * Measured 2026-09-08 15:43-16:45 on the OpenCode free tier: median 162 s per
 * turn, so a 60-minute node budget bought eleven turns of inventory and the
 * node died before its first generation call; eleven dependents were skipped.
 * A budget that does not know the pace is a turn count nobody chose.
 */
const TURN_PACE_WINDOW = 20;
const recentTurnMs: number[] = [];

export function noteTurnDuration(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  recentTurnMs.push(ms);
  if (recentTurnMs.length > TURN_PACE_WINDOW) recentTurnMs.shift();
}

/** Median duration of recent answered turns, or undefined before any turn answered. */
export function medianTurnMs(): number | undefined {
  if (recentTurnMs.length === 0) return undefined;
  const sorted = [...recentTurnMs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Test seam. */
export function resetTurnPace(): void {
  recentTurnMs.length = 0;
}

export interface ProviderCallOutcome {
  readonly response?: ProviderResponse;
  readonly error?: unknown;
}

export function logProviderCall(
  label: string,
  provider: Pick<IAIProvider, "name">,
  startedAt: number,
  outcome: ProviderCallOutcome,
  extra: Record<string, unknown> = {},
): void {
  const ms = Date.now() - startedAt;
  const { response, error } = outcome;
  if (response) {
    if (label === "turn") noteTurnDuration(ms);
    getLogger().info("Provider call", {
      label,
      provider: response.servedBy?.provider ?? provider.name,
      model: response.servedBy?.model,
      ms,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      stopReason: response.stopReason,
      toolCalls: response.toolCalls?.length ?? 0,
      ...extra,
    });
    return;
  }
  getLogger().info("Provider call failed", {
    label,
    provider: provider.name,
    ms,
    error: describeThrown(error).slice(0, 200),
    ...extra,
  });
}

/**
 * What was thrown, readable. A cancel token aborts fetch() with its
 * CancelReason OBJECT as the reason, so `String(error)` printed
 * "[object Object]" — measured 2026-09-08 14:45:56 on two 17-minute calls
 * whose only record of why they ended was that string.
 */
export function describeThrown(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}
