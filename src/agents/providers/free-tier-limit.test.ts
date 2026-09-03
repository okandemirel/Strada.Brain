import { describe, expect, it, afterEach } from "vitest";
import { ProviderHealthRegistry } from "./provider-health.js";

/**
 * Measured live 2026-09-03: OpenCode answered
 * {"type":"FreeUsageLimitError","message":"Rate limit exceeded"} with HTTP
 * 429. The chain read the 429 as congestion and gave it a 5-minute cooldown,
 * whose expiry sent a probe that drew another 429 — 195 refusals in three
 * hours while the campaign sat parked.
 */
const NAME = "ft-probe";
afterEach(() => ProviderHealthRegistry.getInstance().clearProviderState(NAME));

describe("free-tier usage cap", () => {
  it("waits far longer than an overload, and far less than a paid quota block", () => {
    const registry = ProviderHealthRegistry.getInstance();
    registry.clearProviderState(NAME);
    registry.recordFreeTierExhausted(NAME, "FreeUsageLimitError: Rate limit exceeded");

    const entry = registry.getAllEntries().get(NAME)!;
    const waitMin = (entry.cooldownUntil - Date.now()) / 60_000;
    expect(entry.status).toBe("down");
    expect(waitMin).toBeGreaterThan(30);
    expect(waitMin).toBeLessThan(120);
  });

  it("never shortens a longer cooldown already in place", () => {
    const registry = ProviderHealthRegistry.getInstance();
    registry.clearProviderState(NAME);
    registry.recordQuotaExhausted(NAME, "403 quota exceeded");
    const long = registry.getAllEntries().get(NAME)!.cooldownUntil;
    registry.recordFreeTierExhausted(NAME, "FreeUsageLimitError");
    expect(registry.getAllEntries().get(NAME)!.cooldownUntil).toBe(long);
  });
});
