/**
 * A quota that refreshes next month does not refresh in fifteen minutes.
 *
 * The short cooldown exists so a lone provider is not benched for eight hours
 * over one bad minute. Applied to a billing-cycle exhaustion it guarantees the
 * opposite: measured 2026-08-21, Kimi returned "You've reached your usage limit
 * for this billing cycle. Your quota will be refreshed in the next cycle." and
 * was recorded down for fifteen minutes. Run 35 booted after that window had
 * lapsed, the supervisor saw a live provider, and handed it three of four
 * tasks — every one of which died on the same 403.
 *
 * The provider said when it would be back. Believe it.
 */

import { describe, expect, it } from "vitest";

import { recordProviderHealthFailure } from "./orchestrator-runtime-utils.js";

function route(errorMsg: string, isSingleProvider: boolean): string {
  const calls: string[] = [];
  const registry = {
    recordFailure: () => calls.push("failure"),
    recordQuotaExhausted: () => calls.push("quota-long"),
    recordQuotaExhaustedShort: () => calls.push("quota-short"),
    recordOverloaded: () => calls.push("overload-long"),
    recordOverloadedShort: () => calls.push("overload-short"),
    recordQuotaHardStop: () => calls.push("hard-stop"),
  };
  recordProviderHealthFailure(registry, "kimi", errorMsg, { isSingleProvider });
  return calls.join(",");
}

const CYCLE =
  'Kimi (Moonshot) API error 403: {"error":{"message":"You\'ve reached your usage limit ' +
  'for this billing cycle. Your quota will be refreshed in the next cycle."}}';

describe("how long a provider stays benched", () => {
  it("benches a billing-cycle quota for the long cooldown even when it is the only provider", () => {
    expect(route(CYCLE, true)).not.toBe("quota-short");
  });

  it("still benches it long when other providers exist", () => {
    expect(route(CYCLE, false)).not.toBe("quota-short");
  });

  it("keeps the short cooldown for a quota that says nothing about a cycle", () => {
    // A bare 403 quota may well be a per-minute or per-hour cap; benching a
    // lone provider for eight hours over one would end the run for nothing.
    const bare = 'API error 403: {"error":{"message":"quota exceeded"}}';

    expect(route(bare, true)).toBe("quota-short");
    expect(route(bare, false)).toBe("quota-long");
  });

  it("does not treat a per-minute rate limit as a cycle exhaustion", () => {
    const perMinute = 'API error 403: {"error":{"message":"usage limit reached, retry in 20s"}}';

    expect(route(perMinute, true)).toBe("quota-short");
  });
});
