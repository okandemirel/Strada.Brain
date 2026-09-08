import { describe, expect, it } from "vitest";
import { isOutageCausedSettle, RECENT_PROVIDER_FAILURE_MS } from "./campaign-manager.js";

/**
 * Measured live 2026-09-04 19:36: mcov1 settled with
 * "[goal_x] blocked:provider_unavailable" while the zen endpoint answered 503
 * in bursts. The registry's five-minute overload cooldown had lapsed between
 * the failure and the settle, so the cooling measure read 0, the exemption did
 * not fire, and the sprint was FAILED after "2 attempts" it had spent on an
 * endpoint that never answered.
 */
describe("was it the provider layer that stopped the run", () => {
  const BLOCKED = "Blocked:\n[goal_1788537967016_79ce7acf] blocked:provider_unavailable";

  it("trusts the executor's own marker with no second opinion", () => {
    // coolingMs 0 is exactly the live case: the registry disagreed.
    expect(isOutageCausedSettle(BLOCKED, 0)).toBe(true);
    expect(isOutageCausedSettle(BLOCKED, 60_000)).toBe(true);
  });

  it("still requires the registry to agree for free text", () => {
    // A model that merely says "quota" must not arm this on wording alone:
    // that once made planning replan every two minutes with no attempt budget.
    expect(isOutageCausedSettle("hit a provider quota, I think", 0)).toBe(false);
    expect(isOutageCausedSettle("hit a provider quota, I think", 60_000)).toBe(true);
  });

  it("a real sprint failure is not an outage", () => {
    expect(isOutageCausedSettle("compile failed with 43 errors", 60_000)).toBe(false);
    expect(isOutageCausedSettle("", 60_000)).toBe(false);
  });

  it("the executor's inactivity stop is an outage when a provider failed recently — even if a probe passed since", () => {
    // Measured 2026-09-08 06:58: two 600 s provider-stalls, two first-response
    // aborts, then "no progress for 1200000ms"; a 40-token probe passed seconds
    // later, coolingMs read 0, and attempt 1 → 2 for a queue never passed.
    const STALL = "The task stalled without making progress, so it was stopped. Please try again or break the request into smaller steps.";
    expect(isOutageCausedSettle(STALL, 0, 5 * 60_000)).toBe(true);
    expect(isOutageCausedSettle("Task made no progress for 1200000ms", 0, RECENT_PROVIDER_FAILURE_MS)).toBe(true);
    // No provider failure on record: a stall is the sprint's own (a hung tool).
    expect(isOutageCausedSettle(STALL, 0)).toBe(false);
    expect(isOutageCausedSettle(STALL, 0, RECENT_PROVIDER_FAILURE_MS + 1)).toBe(false);
  });
});
