/**
 * A supervisor run's Budget (ACR-9), and the scope its own calls are debited in (task #87).
 *
 * The supervisor runs before any run is open, so there is no run budget to carve its nodes from:
 * they share the global headroom other in-flight work has not reserved. The output-token cap stays
 * per node run (its own policy), so only cost is shared.
 *
 * The supervisor's own calls — the plan, and whatever else it asks a model — are recorded through
 * the accounting funnels, which debit the Budget whose scope is open around them. Without a scope
 * here the plan's debit went nowhere and every node slice was carved from a ceiling that never saw
 * it (QA 2026-11-16). Each node's run opens its own scope on its slice (node → pool holder → this
 * Budget), so nothing is counted twice.
 */

import { createBudget, type Budget } from "../agent-core/control/budget.js";
import { withRunBudget } from "../agent-core/control/budget-scope.js";
import { resolveUnreservedCostCapUsd } from "../agent-core/engine/budget.js";

type BudgetManagerSource = Parameters<typeof resolveUnreservedCostCapUsd>[0]["unifiedBudgetManager"];

/** Runs `execute` with a fresh supervisor run Budget, inside that Budget's scope. */
export function withSupervisorRunBudget<T>(
  unifiedBudgetManager: BudgetManagerSource,
  execute: (runBudget: Budget) => Promise<T>,
): Promise<T> {
  const runBudget = createBudget(Number.POSITIVE_INFINITY, resolveUnreservedCostCapUsd({ unifiedBudgetManager }));
  return withRunBudget(runBudget, () => execute(runBudget));
}
