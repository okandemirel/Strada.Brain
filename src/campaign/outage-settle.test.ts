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

  it("trusts the provider chain's own verdict too — even after the probe has since succeeded", () => {
    // Measured 2026-09-08 15:18: the sprint settled on this text, the recovery
    // probe succeeded 24 s later (coolingMs 0, no failure on record), and the
    // campaign charged attempt 2 for an outage it had already outlived.
    const CHAIN =
      "Task execution failed: All providers failed or unavailable. A recovery probe was already in flight for 1 provider(s); this call measured nothing. Retry shortly.";
    expect(isOutageCausedSettle(CHAIN, 0, Number.POSITIVE_INFINITY)).toBe(true);
    expect(isOutageCausedSettle("All providers failed or unavailable. All providers are in cooldown.", 0)).toBe(true);
  });

  it("the Turkish executor's stop text is the same stop (Codex review 2026-09-08)", () => {
    const TR = "Görev ilerleme kaydetmeden takıldı, bu yüzden durduruldu. Lütfen tekrar deneyin ya da isteği daha küçük adımlara bölün.";
    expect(isOutageCausedSettle(TR, 0, 1_000)).toBe(true);
    expect(isOutageCausedSettle(TR, 0, RECENT_PROVIDER_FAILURE_MS + 1)).toBe(false);
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

  /**
   * Measured live 2026-09-14 04:58: fifteen minutes of provider stalls
   * (deepseek-flash "sent no response within 300000ms", twice), the task
   * killed for inactivity, and by the time the campaign asked, the chain had
   * ANSWERED again — so `lastFailureAt` was cleared, no failure was on
   * record, and the sprint was charged two attempts for the provider's
   * outage. The campaign then ended: "NOT DELIVERED — Session Design blocked
   * after 2 attempts".
   */
  it("a failure DURING the attempt explains the attempt, even after the chain heals", () => {
    const STALL = "The task stalled without making progress, so it was stopped. Please try again or break the request into smaller steps.";
    // Nothing on record now, and nothing during the attempt: the sprint's own.
    expect(isOutageCausedSettle(STALL, 0, Number.POSITIVE_INFINITY, 0)).toBe(false);
    // Two failures happened while this attempt was alive.
    expect(isOutageCausedSettle(STALL, 0, Number.POSITIVE_INFINITY, 2)).toBe(true);
    // …and a real sprint failure is still not an outage, whatever the chain did.
    expect(isOutageCausedSettle("compile failed with 43 errors", 0, Number.POSITIVE_INFINITY, 5)).toBe(false);
  });
});

/**
 * QUOTED PROSE IS NOT A SETTLEMENT (Codex 2026-09-13 AK#10).
 *
 * The phrase matched anywhere in the output, so a game validator that quoted
 * it bought the sprint a fresh attempt budget and an uncounted revival — as
 * often as it liked, while the providers were healthy the whole time.
 */
describe("who said it, and where", () => {
  it("refuses a settlement that merely TALKS ABOUT the provider message", () => {
    const quoted =
      'Game validator failed while checking the literal string "All providers failed or unavailable"; providers are healthy.';
    expect(isOutageCausedSettle(quoted, 0)).toBe(false);
    // …and the same for the executor's stall wording.
    expect(isOutageCausedSettle('the test asserts the message "stalled without making progress" is shown', 0, 1_000)).toBe(false);
  });

  it("still trusts the chain and the executor when they report it themselves", () => {
    expect(isOutageCausedSettle("Task execution failed: All providers failed or unavailable. Retry shortly.", 0)).toBe(true);
    expect(isOutageCausedSettle("All providers failed or unavailable. All providers are in cooldown.", 0)).toBe(true);
    expect(isOutageCausedSettle("Attempt 2 — the run stalled without making progress, so it was stopped.", 0, 1_000)).toBe(true);
    expect(isOutageCausedSettle("The task made no progress for 600000ms.", 0, 1_000)).toBe(true);
    // A second line is still a line of its own.
    expect(isOutageCausedSettle("sprint failed\nAll providers failed or unavailable", 0)).toBe(true);
  });
});
