/**
 * The one way a direct provider call reaches the spend counters.
 *
 * A model turn is billed by the engine (recordProviderUsage: metrics, the rate
 * limiter's daily cost, the run's onUsage). Every other call — a verifier, a
 * planner, a summarizer, a background reasoner — called `provider.chat` or
 * `streamOrChatText` and read only the text: its tokens reached no cost
 * ledger, no daily wall and no /api/metrics counter. Ten such call sites were
 * found at once (task #71), the third time the gap surfaced as "one more
 * caller" (task #67 was the goal decomposer).
 *
 * So a direct call goes through {@link billedChat} or
 * {@link billedStreamOrChatText}, and the caller says only WHO pays
 * ({@link ProviderCallBilling}): a run (its onUsage), or no run (a budget
 * source). The billing itself is not the caller's to get right:
 *   - each reply that came back is billed once;
 *   - what attempts the reply superseded inside a chain had spent
 *     (auxiliaryUsage), and what a call that threw had spent (error.usage),
 *     are billed as the chain records them — the way the worker loop does;
 *   - a reply with no usage, or 0 in and 0 out, is logged "not measured" and
 *     writes no zero.
 *
 * The ledger is installed once per process by bootstrap
 * ({@link installProviderUsageLedger}); background callers have no engine to
 * hand them one. `src/agents/providers/billed-call-tripwire.test.ts` fails on
 * a new direct call that bypasses this module.
 */

import type { IAIProvider } from "./provider.interface.js";
import { streamOrChatText } from "./provider.interface.js";
import type { ProviderResponse, TokenUsage } from "./provider-core.interface.js";
import type { TaskUsageEvent } from "../../tasks/types.js";
import type { BudgetSource } from "../../budget/budget-types.js";
import { getLoggerSafe } from "../../utils/logger.js";

// ─── What one served call cost (first written for the goal decomposer, task #67) ───

/** One served call: who answered and what it billed. */
export interface ServedUsage {
  /** The chain member that answered (servedBy), else the provider's own name. */
  readonly provider: string;
  readonly model?: string;
  readonly usage: TokenUsage;
}

export type ServedUsageSink = (usage: ServedUsage) => void;

/** Why a served reply was not billed: its usage was absent, or read 0 in and 0 out. */
export type UnmeasuredUsage = { readonly provider: string; readonly model?: string; readonly reason: string };

/**
 * Report one served reply to the sink — exactly once per reply that came back.
 *
 * A reply whose usage is absent, or reads 0 tokens in and 0 out, was NOT
 * measured: a call that sent a prompt consumed input tokens, and the provider
 * parsers collapse a missing usage field into zeros. Writing that zero would
 * tell the budget the call was free, so it is not written; the return value
 * says why, for the caller to log. Returns undefined when the reply was billed.
 */
export function reportServedUsage(
  sink: ServedUsageSink | undefined,
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

/**
 * Bill what a call that THREW had already spent. The chain hangs the tokens of
 * the attempts that consumed them on the error (fallback-chain.ts attachLost);
 * the worker's model turns bill that, and so does every direct call. Returns
 * whether anything was billed — false means the attempt's spend was not measured.
 */
export function reportFailedCallUsage(sink: ServedUsageSink | undefined, err: unknown, providerName: string): boolean {
  const spent = (err as { usage?: TokenUsage } | null)?.usage;
  if (!hasTokens(spent)) return false;
  sink?.({ provider: providerName, usage: spent });
  return true;
}

function hasTokens(usage: TokenUsage | undefined): usage is TokenUsage {
  return usage !== undefined && (usage.inputTokens > 0 || usage.outputTokens > 0);
}

// ─── Who pays ────────────────────────────────────────────────────────────────

/** The call is part of a run: it bills the run's own sink, as the run's model turns do. */
export interface RunBilling {
  /** What the call is for, in logs ("supervisor-verification"). */
  readonly purpose: string;
  /** The run's onUsage. Absent on an interactive run, whose turns bill the counters only. */
  readonly run: { readonly onUsage?: (usage: TaskUsageEvent) => void };
}

/** The call belongs to no run: it is booked to the cost ledger under this budget source. */
export interface OwnerlessBilling {
  /** What the call is for; recorded as the ledger row's trigger ("session-summary"). */
  readonly purpose: string;
  readonly ownerless: BudgetSource;
}

export type ProviderCallBilling = RunBilling | OwnerlessBilling;

// ─── The process ledger ──────────────────────────────────────────────────────

/** Where billed usage goes; built by createProviderUsageLedger (agent-core/engine/accounting.ts). */
export interface ProviderUsageLedger {
  record(served: ServedUsage, billing: ProviderCallBilling): void;
}

let installed: ProviderUsageLedger | undefined;

/** Bootstrap installs the process ledger once; undefined uninstalls it (tests). */
export function installProviderUsageLedger(ledger: ProviderUsageLedger | undefined): void {
  installed = ledger;
}

function sinkFor(billing: ProviderCallBilling): ServedUsageSink {
  return (served) => {
    if (!installed) {
      getLoggerSafe().warn("Provider call not billed — no usage ledger is installed", { purpose: billing.purpose, ...served });
      return;
    }
    installed.record(served, billing);
  };
}

async function billed(
  provider: IAIProvider,
  billing: ProviderCallBilling,
  call: () => Promise<ProviderResponse>,
): Promise<ProviderResponse> {
  const sink = sinkFor(billing);
  let response: ProviderResponse;
  try {
    response = await call();
  } catch (err) {
    if (!reportFailedCallUsage(sink, err, provider.name)) {
      getLoggerSafe().warn("Provider call usage not measured — the call threw before a reply", {
        purpose: billing.purpose,
        provider: provider.name,
      });
    }
    throw err;
  }
  const unmeasured = reportServedUsage(sink, response, provider.name);
  if (unmeasured) {
    getLoggerSafe().warn("Provider call usage not measured — nothing billed for this call", { purpose: billing.purpose, ...unmeasured });
  }
  return response;
}

/**
 * `provider.chat(...args)`, billed to `billing` (see the module comment). The
 * arguments go through exactly as the caller wrote them.
 */
export function billedChat(
  provider: IAIProvider,
  billing: ProviderCallBilling,
  ...args: Parameters<IAIProvider["chat"]>
): Promise<ProviderResponse> {
  return billed(provider, billing, () => provider.chat(...args));
}

/** The arguments {@link streamOrChatText} takes after the provider. */
type StreamOrChatArgs = Parameters<typeof streamOrChatText> extends [IAIProvider, ...infer Rest] ? Rest : never;

/** `streamOrChatText(provider, ...args)`, billed to `billing` (see the module comment). */
export function billedStreamOrChatText(
  provider: IAIProvider,
  billing: ProviderCallBilling,
  ...args: StreamOrChatArgs
): Promise<ProviderResponse> {
  return billed(provider, billing, () => streamOrChatText(provider, ...args));
}
