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
    error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
    ...extra,
  });
}
