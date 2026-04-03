import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderHealthRegistry } from "./provider-health.js";

/**
 * Helper: push a provider through N consecutive failures to trigger "down" status.
 */
function triggerDown(
  registry: ProviderHealthRegistry,
  provider: string,
  downThreshold: number,
): void {
  for (let i = 0; i < downThreshold; i++) {
    registry.recordFailure(provider, "error");
  }
}

describe("ProviderHealthRegistry — adaptive cooldown", () => {
  afterEach(() => {
    ProviderHealthRegistry.resetInstance();
    vi.restoreAllMocks();
  });

  it("cooldown escalates on repeated down cycles", () => {
    const BASE_COOLDOWN = 120_000; // 2 min
    const registry = new ProviderHealthRegistry({
      degradedThreshold: 2,
      downThreshold: 3,
      degradedCooldownMs: 30_000,
      downCooldownMs: BASE_COOLDOWN,
    });

    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    // First down episode — cooldown = base (120s)
    triggerDown(registry, "testprov", 3);
    const entry1 = registry.getEntry("testprov")!;
    expect(entry1.status).toBe("down");
    expect(entry1.cooldownUntil).toBe(now + BASE_COOLDOWN); // 120_000
    expect(registry.getDownEpisodes("testprov")).toBe(1);

    // Simulate cooldown expiry — advance time and trigger down again
    const later = now + BASE_COOLDOWN + 1;
    vi.spyOn(Date, "now").mockReturnValue(later);

    // Reset failure count by creating a fresh cycle (provider auto-recovers after cooldown)
    // We need to re-fail from zero, so manually set up a new instance to avoid stacking
    // Actually the registry still has the old entry with consecutiveFailures=3,
    // so further recordFailure will increment from 3. Let's just record more failures.
    // For a clean second episode, we need to recordSuccess first (auto-recovery).
    registry.recordSuccess("testprov"); // This also resets downEpisodes — but that's the "success resets" behavior
    // For this test, we actually want to NOT call recordSuccess (the provider just
    // came back from cooldown without an explicit success). So let's use a fresh approach:

    // Re-create a clean registry to test episode counting independently
    const reg2 = new ProviderHealthRegistry({
      degradedThreshold: 2,
      downThreshold: 3,
      degradedCooldownMs: 30_000,
      downCooldownMs: BASE_COOLDOWN,
    });

    vi.spyOn(Date, "now").mockReturnValue(now);

    // Episode 0 → cooldown = BASE * 2^0 = 120_000
    triggerDown(reg2, "prov", 3);
    expect(reg2.getEntry("prov")!.cooldownUntil).toBe(now + BASE_COOLDOWN);
    expect(reg2.getDownEpisodes("prov")).toBe(1);

    // Simulate cooldown expiry — provider becomes available again via isAvailable()
    // but no explicit recordSuccess, so downEpisodes stays at 1.
    // We need to reset consecutiveFailures to start a fresh failure cycle.
    // In practice, the provider is retried after cooldown and if it fails again,
    // failures stack. For testing, we manually trigger more failures.
    // After 3 failures (threshold), it had 3. Now add 3 more → 6 total, still >= threshold.
    // The second time failures >= downThreshold fires, episodes is already 1.

    vi.spyOn(Date, "now").mockReturnValue(now + BASE_COOLDOWN + 1);

    // Episode 1 → cooldown = BASE * 2^1 = 240_000
    // Record enough failures to re-trigger (any single failure keeps it >= threshold since consecutiveFailures is already 3+)
    reg2.recordFailure("prov", "error again");
    const entry2 = reg2.getEntry("prov")!;
    expect(entry2.status).toBe("down");
    expect(entry2.cooldownUntil).toBe(now + BASE_COOLDOWN + 1 + BASE_COOLDOWN * 2);
    expect(reg2.getDownEpisodes("prov")).toBe(2);
  });

  it("cooldown caps at MAX_ADAPTIVE_COOLDOWN_MS (10 minutes)", () => {
    const BASE_COOLDOWN = 120_000;
    const MAX_COOLDOWN = 10 * 60 * 1000; // 600_000
    const registry = new ProviderHealthRegistry({
      degradedThreshold: 2,
      downThreshold: 3,
      degradedCooldownMs: 30_000,
      downCooldownMs: BASE_COOLDOWN,
    });

    let time = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => time);

    // Trigger many down episodes — each subsequent failure (after already being >= threshold)
    // increments the episode counter.
    // Episode 0: 120_000, Episode 1: 240_000, Episode 2: 480_000, Episode 3: 600_000 (capped)

    // First down (episode 0)
    triggerDown(registry, "prov", 3);
    expect(registry.getEntry("prov")!.cooldownUntil).toBe(time + BASE_COOLDOWN);

    // Subsequent failures keep triggering down (consecutiveFailures stays >= threshold)
    time += BASE_COOLDOWN + 1;

    // Episode 1: 240_000
    registry.recordFailure("prov", "err");
    expect(registry.getEntry("prov")!.cooldownUntil).toBe(time + BASE_COOLDOWN * 2);

    time += BASE_COOLDOWN * 2 + 1;

    // Episode 2: 480_000
    registry.recordFailure("prov", "err");
    expect(registry.getEntry("prov")!.cooldownUntil).toBe(time + BASE_COOLDOWN * 4);

    time += BASE_COOLDOWN * 4 + 1;

    // Episode 3: would be 960_000 but capped at 600_000
    registry.recordFailure("prov", "err");
    expect(registry.getEntry("prov")!.cooldownUntil).toBe(time + MAX_COOLDOWN);

    time += MAX_COOLDOWN + 1;

    // Episode 4: still capped at 600_000
    registry.recordFailure("prov", "err");
    expect(registry.getEntry("prov")!.cooldownUntil).toBe(time + MAX_COOLDOWN);
  });

  it("success resets down episode counter", () => {
    const BASE_COOLDOWN = 120_000;
    const registry = new ProviderHealthRegistry({
      degradedThreshold: 2,
      downThreshold: 3,
      degradedCooldownMs: 30_000,
      downCooldownMs: BASE_COOLDOWN,
    });

    let time = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => time);

    // First down episode
    triggerDown(registry, "prov", 3);
    expect(registry.getDownEpisodes("prov")).toBe(1);

    // Advance past cooldown, then add one more failure to bump episode
    time += BASE_COOLDOWN + 1;
    registry.recordFailure("prov", "err");
    expect(registry.getDownEpisodes("prov")).toBe(2);

    // Now record a success — this should reset episodes to 0
    registry.recordSuccess("prov");
    expect(registry.getDownEpisodes("prov")).toBe(0);
    expect(registry.getStatus("prov")).toBe("healthy");

    // Trigger down again — cooldown should be back to base (episode 0)
    time += 1000;
    triggerDown(registry, "prov", 3);
    expect(registry.getEntry("prov")!.cooldownUntil).toBe(time + BASE_COOLDOWN);
    expect(registry.getDownEpisodes("prov")).toBe(1);
  });

  it("degraded cooldown is not affected by episodes", () => {
    const DEGRADED_COOLDOWN = 30_000;
    const BASE_COOLDOWN = 120_000;
    const registry = new ProviderHealthRegistry({
      degradedThreshold: 2,
      downThreshold: 5,
      degradedCooldownMs: DEGRADED_COOLDOWN,
      downCooldownMs: BASE_COOLDOWN,
    });

    let time = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => time);

    // First: trigger down to accumulate episodes
    triggerDown(registry, "prov", 5);
    expect(registry.getDownEpisodes("prov")).toBe(1);

    // Further failure re-triggers down with episode 1
    time += BASE_COOLDOWN + 1;
    registry.recordFailure("prov", "err");
    expect(registry.getDownEpisodes("prov")).toBe(2);

    // Now create a fresh provider that only reaches degraded (not down)
    // 2 failures = degraded (threshold=2), not down (threshold=5)
    registry.recordFailure("other", "err");
    registry.recordFailure("other", "err");
    const entry = registry.getEntry("other")!;
    expect(entry.status).toBe("degraded");
    expect(entry.cooldownUntil).toBe(time + DEGRADED_COOLDOWN);
    expect(registry.getDownEpisodes("other")).toBe(0);

    // Even if we degrade again after recovery, cooldown stays the same
    time += DEGRADED_COOLDOWN + 1;
    // Reset via success, then degrade again
    registry.recordSuccess("other");
    registry.recordFailure("other", "err");
    registry.recordFailure("other", "err");
    const entry2 = registry.getEntry("other")!;
    expect(entry2.status).toBe("degraded");
    expect(entry2.cooldownUntil).toBe(time + DEGRADED_COOLDOWN);
  });
});
