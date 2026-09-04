import { describe, expect, it } from "vitest";
import { isOutageCausedSettle } from "./campaign-manager.js";

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
});
