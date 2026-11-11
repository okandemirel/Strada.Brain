/**
 * Boot wiring of the spend counters: the rate limiter's stored policy, its
 * caps seeded from the durable ledger, the live limiter handed to the
 * dashboard, and the process ledger every direct provider call bills through
 * (billed-call.ts, task #71). Moved out of bootstrap.ts (file-size contract).
 */

import type * as winston from "winston";
import {
  applyStoredRateLimitOverrides,
  type RateLimiter,
  type RateLimitOverrideSource,
  type SpendLedgerReader,
} from "../security/rate-limiter.js";
import type { MetricsCollector } from "../dashboard/metrics.js";
import type { BudgetSource, CostMetadata } from "../budget/budget-types.js";
import { installProviderUsageLedger } from "../agents/providers/billed-call.js";
import { createProviderUsageLedger } from "../agent-core/engine/accounting.js";

export interface SpendCountersParams {
  readonly rateLimiter: RateLimiter | undefined;
  readonly metrics: MetricsCollector;
  /** Where the dashboard's saved rate limits live (daemon storage). */
  readonly overrides: RateLimitOverrideSource;
  /** The durable cost ledger (UnifiedBudgetManager). */
  readonly ledger: SpendLedgerReader & {
    recordCost(amount: number, source: BudgetSource, metadata: CostMetadata): void;
  };
  readonly dashboard: { setRateLimiter(limiter: RateLimiter): void } | undefined;
  readonly logger: winston.Logger;
}

export function wireSpendCounters(params: SpendCountersParams): void {
  const { rateLimiter } = params;
  // Rate limits the dashboard saved are policy, not a stored note: apply them
  // to the limiter this boot constructed from config, and hand the dashboard
  // the live limiter so a later POST changes what is enforced immediately
  // (item 2.7 — the stored override was written, read back by the GET, and
  // never enforced by anything).
  if (rateLimiter) {
    applyStoredRateLimitOverrides(rateLimiter, params.overrides, params.logger);
    // The spend caps count from the durable ledger, not from zero, so a
    // restart does not hand out a fresh day's budget (SEC-21).
    rateLimiter.seedSpend(params.ledger);
    params.dashboard?.setRateLimiter(rateLimiter);
  }
  // A direct provider call — a verifier, a planner, a summarizer — bills the
  // counters a model turn bills, and a call no run owns is booked to the
  // ledger. Until this, their tokens reached none of them (task #71).
  installProviderUsageLedger(
    createProviderUsageLedger({ counters: { metrics: params.metrics, rateLimiter }, budget: params.ledger }),
  );
}
