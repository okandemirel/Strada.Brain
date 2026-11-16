/**
 * Agent Core v2 — WHICH RUN'S BUDGET a provider call spends (task #87).
 *
 * The v2 runner debited its model turns into the run's Budget and nothing else. A run's other
 * provider calls — goal decomposition, reviewer calls, consensus verification — were recorded
 * (metrics, the rate limiter, the run's onUsage) and never debited, so the token and cost gates
 * judged "budget-exhausted" on a short count. Every recorded call passes through the two
 * accounting funnels (engine/accounting.ts: recordProviderUsage, recordAuxiliaryUsage); they debit
 * the Budget of the run they run inside, model turns included, so each call is counted once.
 *
 * Ambient rather than threaded, like the run's provenance (learning/run-provenance.ts) and the
 * chat scope (agents/providers/chat-scope.ts): a run's calls reach the funnels through the engine,
 * the intervention pipeline, the decomposer and the consensus manager, and none of those is handed
 * the run. The run's onUsage cannot carry it: a sink that is always set would end the shell
 * review's fallback to the Orchestrator's own sink on a run that has none (review.ts).
 *
 * A delegated run opens its own scope, inside its parent's. Its Budget passes each debit on to the
 * parent (createBudget's `parent`), so the parent counts the child's spend once, through that link.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { estimateCostWithCache } from "../../budget/cost-model.js";
import type { TokenUsage as ProviderTokenUsage } from "../../agents/providers/provider-core.interface.js";
import type { Budget, TokenUsage } from "./budget.js";

const current = new AsyncLocalStorage<Budget>();

/** Runs `fn` with `budget` as the Budget of every provider call recorded inside it. */
export function withRunBudget<T>(budget: Budget, fn: () => T): T {
  return current.run(budget, fn);
}

/** The Budget of the run this code runs inside, or undefined outside one. */
export function runBudget(): Budget | undefined {
  return current.getStore();
}

/** Debits one served call from the running run's Budget; outside a run it debits nothing. */
export function debitRunBudget(
  usage: ProviderTokenUsage | undefined,
  providerName: string,
  modelId: string | undefined,
): void {
  current.getStore()?.debit(toBudgetUsage(usage, providerName, modelId));
}

/** Provider `TokenUsage` → control-plane `Budget` usage, with the call's estimated USD cost.
 * The cost is an ESTIMATE (flat per-provider rate table) whose only consumer is the run-local
 * Budget gate seeded from the unified budget manager's remaining headroom — it never persists
 * anything (billing/recording stays with the accounting funnels), so there is no double-count.
 * A provider with unknown/zero rates (e.g. ollama) simply gates on tokens alone.
 * audited 2026-09-02: the model id was not passed, so estimateCost could never apply its
 * "-free"/":free" → $0 rule and a free-tier model (opencode Zen, OpenRouter :free) was charged
 * its provider's paid table rate against the run's cost cap — money nobody was billed, spent out
 * of a live run's headroom. The model the call was SERVED by is the one that priced it. */
export function toBudgetUsage(
  usage: ProviderTokenUsage | undefined,
  providerName: string,
  modelId: string | undefined,
): TokenUsage {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  // CACHE-AWARE, like the ledger. The gate priced every input token at the
  // full rate while the ledger billed cache reads at a tenth: one million
  // cache-read tokens debited $3.00 from the run's headroom against $0.30
  // recorded — a run stopped on phantom cost (audit 03.2 / D21, 2026-09-13).
  return {
    inputTokens,
    outputTokens,
    costUsd: estimateCostWithCache(
      {
        inputTokens,
        outputTokens,
        ...(usage?.cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens: usage.cacheCreationInputTokens }),
        ...(usage?.cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens: usage.cacheReadInputTokens }),
        ...(modelId === undefined ? {} : { model: modelId }),
      },
      providerName,
    ),
  };
}
