import { describe, expect, it, afterEach } from "vitest";
import { describeProviderOutage, setLiveChainMemberNames } from "./provider-outage.js";
import { ProviderHealthRegistry } from "./provider-health.js";

const registry = ProviderHealthRegistry.getInstance();

afterEach(() => {
  setLiveChainMemberNames([]);
  for (const name of ["d-quota", "d-short", "d-ok", "d-x1", "d-x2", "d-x3", "d-x4", "d-x5"]) {
    registry.clearProviderState(name);
  }
});

describe("describeProviderOutage", () => {
  /**
   * Audited 2026-09-04: the campaign parked itself saying
   * "Cause: Sprint 7 blocked after 2 attempts: Completed: 1. **Varsayım**: …"
   * — the sprint's own prose, while the actual cause was one account's
   * monthly quota and another's multi-hour wall.
   */
  it("names each member and how long it is out", () => {
    registry.recordQuotaExhausted("d-quota", "Monthly usage limit reached");
    registry.recordOverloaded("d-short", "429");
    setLiveChainMemberNames(["d-quota", "d-short"]);

    const text = describeProviderOutage();
    expect(text).toContain("every configured provider is unavailable");
    expect(text).toContain("d-quota");
    expect(text).toContain("d-short");
    // The horizon, not just the name: "down" alone does not say when to look again.
    expect(text).toMatch(/d-quota [a-z]+ for [\d.]+h/);
  });

  it("ignores providers that are not live chain members", () => {
    registry.recordQuotaExhausted("d-quota", "quota");
    registry.recordQuotaExhausted("d-ok", "quota");
    setLiveChainMemberNames(["d-quota"]);
    const text = describeProviderOutage();
    expect(text).toContain("d-quota");
    expect(text).not.toContain("d-ok");
  });

  it("says it trimmed the list instead of capping it silently", () => {
    const names = ["d-x1", "d-x2", "d-x3", "d-x4", "d-x5"];
    for (const n of names) registry.recordQuotaExhausted(n, "quota");
    setLiveChainMemberNames(names);
    expect(describeProviderOutage()).toContain("+1 more");
  });

  it("returns empty when no chain member is declared, so a caller can fall back", () => {
    setLiveChainMemberNames([]);
    // With no declaration every registry name reads as a member; clear the
    // registry's view by declaring a name that has no entry at all.
    setLiveChainMemberNames(["d-nothing-here"]);
    expect(describeProviderOutage()).toBe("");
  });
});
