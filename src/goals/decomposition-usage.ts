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
 *
 * The rules themselves (each reply once, superseded and failed attempts as the
 * chain records them, "not measured" instead of a zero) are every direct
 * call's rules, so they live in the providers layer (billed-call.ts, task #71);
 * these are the decomposer's names for them.
 */

export {
  reportServedUsage as reportDecompositionUsage,
  reportFailedCallUsage as reportFailedAttemptUsage,
  type ServedUsage as DecompositionUsage,
  type ServedUsageSink as DecompositionUsageSink,
  type UnmeasuredUsage,
} from "../agents/providers/billed-call.js";
