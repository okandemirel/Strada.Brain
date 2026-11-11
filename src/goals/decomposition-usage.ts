/**
 * What one goal-decomposition provider call cost, handed to the run that asked
 * for the plan.
 *
 * The decomposer is one instance per daemon, shared by every run, so it cannot
 * own a ledger: the caller passes a sink per call and routes it through the
 * same hook its model turns bill through (Orchestrator.recordProviderUsage →
 * metrics, the rate limiter's daily cost, the task's onUsage). Before this the
 * decomposer read nothing of the response's usage: every plan call — one at
 * least, a few with retries and depth-2 expansions — reached no budget, no
 * cost ledger and no dashboard counter (task #67).
 */

import type { ProviderResponse, TokenUsage } from "../agents/providers/provider-core.interface.js";

/** One served decomposition call: who answered and what it billed. */
export interface DecompositionUsage {
  /** The chain member that answered (servedBy), else the provider's own name. */
  readonly provider: string;
  readonly model?: string;
  readonly usage: TokenUsage;
}

export type DecompositionUsageSink = (usage: DecompositionUsage) => void;

/** Why a served reply was not billed: its usage was absent, or read 0 in and 0 out. */
export type UnmeasuredUsage = { readonly provider: string; readonly model?: string; readonly reason: string };

/**
 * Report one served reply to the sink — exactly once per reply that came back.
 *
 * A reply whose usage is absent, or reads 0 tokens in and 0 out, was NOT
 * measured: a call that sent a prompt consumed input tokens, and the provider
 * parsers collapse a missing usage field into zeros. Writing that zero would
 * tell the budget the plan was free, so it is not written; the return value
 * says why, for the caller to log. Returns undefined when the reply was billed.
 */
export function reportDecompositionUsage(
  sink: DecompositionUsageSink | undefined,
  response: Pick<ProviderResponse, "usage" | "servedBy" | "auxiliaryUsage">,
  providerName: string,
): UnmeasuredUsage | undefined {
  const provider = response.servedBy?.provider ?? providerName;
  const model = response.servedBy?.model;
  const served = { provider, ...(model === undefined ? {} : { model }) };
  // The attempts this reply superseded inside the chain (an empty answer retried,
  // a fall-over): consumed, and billed the way a model turn bills them.
  const lost = response.auxiliaryUsage;
  if (hasTokens(lost)) sink?.({ ...served, usage: lost });
  const usage = response.usage as TokenUsage | undefined;
  if (!hasTokens(usage)) {
    return {
      ...served,
      reason: usage ? "the provider reported 0 input and 0 output tokens" : "the provider returned no usage field",
    };
  }
  sink?.({ ...served, usage });
  return undefined;
}

function hasTokens(usage: TokenUsage | undefined): usage is TokenUsage {
  return usage !== undefined && (usage.inputTokens > 0 || usage.outputTokens > 0);
}

/**
 * Bill what a call that THREW had already spent. The chain hangs the tokens of
 * the attempts that consumed them on the error (fallback-chain.ts attachLost);
 * the worker's model turns bill that, and so does the planner. Returns whether
 * anything was billed — false means the attempt's spend was not measured.
 */
export function reportFailedAttemptUsage(
  sink: DecompositionUsageSink | undefined,
  err: unknown,
  providerName: string,
): boolean {
  const spent = (err as { usage?: TokenUsage } | null)?.usage;
  if (!hasTokens(spent)) return false;
  sink?.({ provider: providerName, usage: spent });
  return true;
}
