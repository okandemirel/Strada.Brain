import { describe, expect, it, afterEach } from "vitest";
import { ProviderHealthRegistry } from "./provider-health.js";
import { allProvidersCoolingDownMs, setLiveChainMemberNames } from "./provider-outage.js";

/**
 * Measured live 2026-09-03 18:39: three OpenCode accounts were holding
 * FreeUsageLimitError 429s, their short cooldowns lapsed between the failing
 * recovery probe and the campaign's settle, the outage measure read 0 — so
 * the settle looked like the sprint's own failure and charged Sprint 7 its
 * second attempt for a wall it never got to work behind.
 */
const names = ["od-a", "od-b"];
afterEach(() => {
  const registry = ProviderHealthRegistry.getInstance();
  for (const n of names) registry.clearProviderState(n);
  setLiveChainMemberNames([]);
});

describe("outage measure vs a down member whose cooldown lapsed", () => {
  it("still reports an outage when every chain member is down", () => {
    const registry = ProviderHealthRegistry.getInstance();
    for (const n of names) {
      registry.clearProviderState(n);
      // Enough failures to mark it down, then let the cooldown lapse.
      for (let i = 0; i < 6; i++) registry.recordFailure(n, "429 FreeUsageLimitError");
      const entry = registry.getAllEntries().get(n);
      if (entry) (entry as { cooldownUntil: number }).cooldownUntil = Date.now() - 1000;
    }
    setLiveChainMemberNames(names);

    expect(allProvidersCoolingDownMs()).toBeGreaterThan(0);
  });

  it("reports capacity as soon as one member recovers", () => {
    const registry = ProviderHealthRegistry.getInstance();
    for (const n of names) {
      registry.clearProviderState(n);
      for (let i = 0; i < 6; i++) registry.recordFailure(n, "429");
      const entry = registry.getAllEntries().get(n);
      if (entry) (entry as { cooldownUntil: number }).cooldownUntil = Date.now() - 1000;
    }
    registry.recordSuccess(names[0]!);
    setLiveChainMemberNames(names);

    expect(allProvidersCoolingDownMs()).toBe(0);
  });
});
