/**
 * A supervisor run's Budget (ACR-9), and the scope its own calls are debited in (task #87).
 *
 * The supervisor runs before any run is open, so there is no run budget to carve its nodes from:
 * they share the global headroom other in-flight work has not reserved. The output-token cap stays
 * per node run (its own policy), so only cost is shared.
 *
 * The supervisor's own calls are recorded through engine/accounting.ts — its funnels, or the
 * direct-call ledger for a run-billed direct call — which debit the Budget whose scope is open
 * around them: the grounding call that summarises an image for the planner, the plan, and what the
 * brain asks a model while it runs (capability triage, node verification). Each node's run opens its own scope
 * on its slice (node → pool holder → this Budget), so nothing is counted twice. Without a scope
 * the plan's debit went nowhere (QA 2026-11-16), and so did the grounding call's (QA, attempt 3).
 *
 * When admission declines after grounding (not decomposable, busy), the grounding spend stays in
 * this Budget, which no node is carved from, and the run that takes the task instead is not
 * charged it: that run seeds its cost cap from the global headroom left after the spend the
 * grounding call already recorded, so charging it again would count it twice.
 */

import { createBudget, type Budget } from "../agent-core/control/budget.js";
import { withRunBudget } from "../agent-core/control/budget-scope.js";
import { resolveUnreservedCostCapUsd } from "../agent-core/engine/budget.js";

type BudgetManagerSource = Parameters<typeof resolveUnreservedCostCapUsd>[0]["unifiedBudgetManager"];

/** One supervisor admission's Budget, opened on first use: every call made `within` it spends it. */
export interface SupervisorRunBudget {
  within<T>(work: (runBudget: Budget) => Promise<T>): Promise<T>;
}

export function supervisorRunBudget(unifiedBudgetManager: BudgetManagerSource): SupervisorRunBudget {
  let budget: Budget | undefined;
  return {
    within(work) {
      const runBudget = (budget ??= createBudget(Number.POSITIVE_INFINITY, resolveUnreservedCostCapUsd({ unifiedBudgetManager })));
      return withRunBudget(runBudget, () => work(runBudget));
    },
  };
}
