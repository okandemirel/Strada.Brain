/**
 * Boot wiring of the spend counters: the rate limiter's stored policy, its
 * caps seeded from the durable ledger, and the live limiter handed to the
 * dashboard. Moved out of bootstrap.ts unchanged (file-size contract).
 */

import type * as winston from "winston";
import {
  applyStoredRateLimitOverrides,
  type RateLimiter,
  type RateLimitOverrideSource,
  type SpendLedgerReader,
} from "../security/rate-limiter.js";

export interface SpendCountersParams {
  readonly rateLimiter: RateLimiter | undefined;
  /** Where the dashboard's saved rate limits live (daemon storage). */
  readonly overrides: RateLimitOverrideSource;
  /** The durable cost ledger (UnifiedBudgetManager). */
  readonly ledger: SpendLedgerReader;
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
}
