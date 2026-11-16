/**
 * What a campaign-level provider call must leave behind (task #71): the
 * counters saw the tokens, and the cost ledger holds one "chat" row per call,
 * triggered by the call's purpose and priced by the cost model.
 */

import { expect } from "vitest";
import { estimateCostWithCache } from "../../common/cost-model.js";
import type { UsageLedgerHarness } from "./usage-ledger-harness.js";

export interface BilledCall {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** One row per call, in call order; the counters hold the sum. */
export function expectBilledAsCampaignWork(
  harness: UsageLedgerHarness,
  expected: { readonly purpose: string; readonly provider: string; readonly calls: readonly BilledCall[] },
): void {
  const input = expected.calls.reduce((n, c) => n + c.inputTokens, 0);
  const output = expected.calls.reduce((n, c) => n + c.outputTokens, 0);
  expect(harness.counted()).toEqual({ input, output, dailyTokens: input + output });
  expect(harness.booked).toHaveLength(expected.calls.length);
  expected.calls.forEach((call, i) => {
    const row = harness.booked[i]!;
    const price = estimateCostWithCache(call, expected.provider);
    expect(price).toBeGreaterThan(0);
    expect(row.source).toBe("chat");
    expect(row.metadata.triggerName).toBe(expected.purpose);
    expect(row.metadata.tokensIn).toBe(call.inputTokens);
    expect(row.metadata.tokensOut).toBe(call.outputTokens);
    expect(row.amount).toBeCloseTo(price, 12);
  });
}

/** The warning billed-call.ts logs for a reply it could not measure. */
export const UNMEASURED_WARNING = "Provider call usage not measured — nothing billed for this call";
