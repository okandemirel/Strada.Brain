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

describe("ProviderHealthRegistry — probe vs real success", () => {
  afterEach(() => {
    ProviderHealthRegistry.resetInstance();
    vi.restoreAllMocks();
  });

  it("probe success downgrades to degraded instead of fully resetting", () => {
    const registry = new ProviderHealthRegistry({
      degradedThreshold: 2,
      downThreshold: 3,
      degradedCooldownMs: 30_000,
      downCooldownMs: 120_000,
    });

    triggerDown(registry, "prov", 3);
    expect(registry.getEntry("prov")!.status).toBe("down");
    expect(registry.getDownEpisodes("prov")).toBe(1);

    registry.recordSuccess("prov", "probe");
    const entry = registry.getEntry("prov")!;
    expect(entry.status).toBe("degraded");
    expect(entry.consecutiveFailures).toBe(2); // decremented from 3, not reset to 0
    expect(entry.cooldownUntil).toBe(0); // allows traffic
    expect(registry.getDownEpisodes("prov")).toBe(1); // NOT reset
  });

  it("real success fully resets to healthy", () => {
    const registry = new ProviderHealthRegistry({
      degradedThreshold: 2,
      downThreshold: 3,
      degradedCooldownMs: 30_000,
      downCooldownMs: 120_000,
    });

    triggerDown(registry, "prov", 3);
    expect(registry.getDownEpisodes("prov")).toBe(1);

    registry.recordSuccess("prov", "real");
    const entry = registry.getEntry("prov")!;
    expect(entry.status).toBe("healthy");
    expect(entry.consecutiveFailures).toBe(0);
    expect(registry.getDownEpisodes("prov")).toBe(0);
  });

  it("default recordSuccess kind is real", () => {
    const registry = new ProviderHealthRegistry({
      degradedThreshold: 2,
      downThreshold: 3,
      degradedCooldownMs: 30_000,
      downCooldownMs: 120_000,
    });

    triggerDown(registry, "prov", 3);
    registry.recordSuccess("prov"); // no kind = "real"
    expect(registry.getEntry("prov")!.status).toBe("healthy");
    expect(registry.getDownEpisodes("prov")).toBe(0);
  });

  it("probe after real failure with 1 consecutive failure keeps at degraded", () => {
    const registry = new ProviderHealthRegistry({
      degradedThreshold: 2,
      downThreshold: 5,
      degradedCooldownMs: 30_000,
      downCooldownMs: 120_000,
    });

    registry.recordFailure("prov", "err");
    expect(registry.getEntry("prov")!.consecutiveFailures).toBe(1);

    registry.recordSuccess("prov", "probe");
    const entry = registry.getEntry("prov")!;
    expect(entry.status).toBe("degraded");
    expect(entry.consecutiveFailures).toBe(1); // max(1, 1-1) = 1
  });
});

describe("ProviderHealthRegistry — recordOverloaded", () => {
  afterEach(() => {
    ProviderHealthRegistry.resetInstance();
    vi.restoreAllMocks();
  });

  it("sets status to down with 5-minute base cooldown", () => {
    const registry = new ProviderHealthRegistry();
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    registry.recordOverloaded("minimax", "HTTP 529 overloaded");
    const entry = registry.getEntry("minimax")!;
    expect(entry.status).toBe("down");
    expect(entry.cooldownUntil).toBe(now + 5 * 60 * 1000); // 5 minutes
    expect(entry.consecutiveFailures).toBe(1);
    expect(registry.getDownEpisodes("minimax")).toBe(1);
  });

  it("escalates cooldown on repeated overloads", () => {
    const registry = new ProviderHealthRegistry();
    let time = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => time);

    // Episode 0: 5 min
    registry.recordOverloaded("minimax", "529");
    expect(registry.getEntry("minimax")!.cooldownUntil).toBe(time + 5 * 60_000);

    time += 5 * 60_000 + 1;

    // Episode 1: 10 min
    registry.recordOverloaded("minimax", "529");
    expect(registry.getEntry("minimax")!.cooldownUntil).toBe(time + 10 * 60_000);
    expect(registry.getDownEpisodes("minimax")).toBe(2);
  });

  it("caps at MAX_ADAPTIVE_COOLDOWN_MS", () => {
    const registry = new ProviderHealthRegistry();
    const MAX = 10 * 60 * 1000;
    let time = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => time);

    // Force many episodes
    for (let i = 0; i < 10; i++) {
      registry.recordOverloaded("prov", "529");
      time += MAX + 1;
    }

    // Last episode cooldown should be capped
    const entry = registry.getEntry("prov")!;
    expect(entry.cooldownUntil).toBeLessThanOrEqual(time + MAX);
  });

  it("probe does not fully reset overload episode escalation", () => {
    const registry = new ProviderHealthRegistry();
    let time = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => time);

    registry.recordOverloaded("prov", "529"); // episode 0
    expect(registry.getDownEpisodes("prov")).toBe(1);

    time += 5 * 60_000 + 1;
    registry.recordSuccess("prov", "probe"); // probe success
    expect(registry.getDownEpisodes("prov")).toBe(1); // still 1

    registry.recordOverloaded("prov", "529"); // episode 1 (escalated)
    expect(registry.getDownEpisodes("prov")).toBe(2);
    // Cooldown should be 10 min (5 * 2^1), not 5 min (5 * 2^0)
    expect(registry.getEntry("prov")!.cooldownUntil).toBe(time + 10 * 60_000);
  });
});

describe("ProviderHealthRegistry — areAllUnavailable", () => {
  afterEach(() => {
    ProviderHealthRegistry.resetInstance();
    vi.restoreAllMocks();
  });

  it("returns false when no providers are tracked", () => {
    const registry = new ProviderHealthRegistry();
    expect(registry.areAllUnavailable()).toBe(false);
  });

  it("returns false when at least one provider is available", () => {
    const registry = new ProviderHealthRegistry({ degradedThreshold: 2, downThreshold: 3, degradedCooldownMs: 30_000, downCooldownMs: 120_000 });
    triggerDown(registry, "prov-a", 3);
    // prov-a is down, but prov-b has never been seen (treated as healthy)
    registry.recordFailure("prov-b", "transient");
    registry.recordSuccess("prov-b");
    expect(registry.areAllUnavailable()).toBe(false);
  });

  it("returns true when all tracked providers are in cooldown", () => {
    const registry = new ProviderHealthRegistry({ degradedThreshold: 2, downThreshold: 3, degradedCooldownMs: 30_000, downCooldownMs: 120_000 });
    triggerDown(registry, "prov-a", 3);
    triggerDown(registry, "prov-b", 3);
    expect(registry.areAllUnavailable()).toBe(true);
  });

  it("returns false when cooldown has expired", () => {
    const registry = new ProviderHealthRegistry({ degradedThreshold: 2, downThreshold: 3, degradedCooldownMs: 30_000, downCooldownMs: 120_000 });
    let time = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => time);
    triggerDown(registry, "prov", 3);
    expect(registry.areAllUnavailable()).toBe(true);
    time += 120_001; // past cooldown
    expect(registry.areAllUnavailable()).toBe(false);
  });

  it("returns true when provider is degraded with active cooldown", () => {
    const registry = new ProviderHealthRegistry({ degradedThreshold: 2, downThreshold: 5, degradedCooldownMs: 30_000, downCooldownMs: 120_000 });
    registry.recordFailure("prov", "err");
    registry.recordFailure("prov", "err"); // degraded with 30s cooldown
    expect(registry.areAllUnavailable()).toBe(true); // in cooldown = unavailable
  });

  it("returns false when degraded cooldown has expired", () => {
    const registry = new ProviderHealthRegistry({ degradedThreshold: 2, downThreshold: 5, degradedCooldownMs: 30_000, downCooldownMs: 120_000 });
    let time = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => time);
    registry.recordFailure("prov", "err");
    registry.recordFailure("prov", "err"); // degraded
    expect(registry.areAllUnavailable()).toBe(true);
    time += 30_001; // past degraded cooldown
    expect(registry.areAllUnavailable()).toBe(false);
  });
});

describe("ProviderHealthRegistry — isRecovering", () => {
  afterEach(() => {
    ProviderHealthRegistry.resetInstance();
    vi.restoreAllMocks();
  });

  it("returns true for providers with expired cooldown and failures", () => {
    const registry = new ProviderHealthRegistry({
      degradedThreshold: 2,
      downThreshold: 5,
      degradedCooldownMs: 30_000,
      downCooldownMs: 120_000,
    });

    let time = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => time);

    // Record enough failures to mark as "down"
    triggerDown(registry, "test-provider", 5);
    const entry = registry.getEntry("test-provider")!;
    expect(entry.status).toBe("down");
    expect(entry.consecutiveFailures).toBe(5);

    // While in cooldown, isRecovering should be false
    expect(registry.isRecovering("test-provider")).toBe(false);

    // Advance past cooldown
    time = entry.cooldownUntil + 1;

    expect(registry.isRecovering("test-provider")).toBe(true);
  });

  it("returns false for healthy providers", () => {
    const registry = new ProviderHealthRegistry();

    // Never-seen provider
    expect(registry.isRecovering("unknown-provider")).toBe(false);

    // Provider that had failures but then succeeded
    registry.recordFailure("good-provider", "transient");
    registry.recordSuccess("good-provider");
    expect(registry.isRecovering("good-provider")).toBe(false);
  });

  it("returns false for providers still in cooldown", () => {
    const registry = new ProviderHealthRegistry({
      degradedThreshold: 2,
      downThreshold: 5,
      degradedCooldownMs: 30_000,
      downCooldownMs: 120_000,
    });

    // Record enough failures to mark as "down"
    triggerDown(registry, "cooling-provider", 5);

    const entry = registry.getEntry("cooling-provider")!;
    expect(entry.status).toBe("down");
    // cooldownUntil is in the future (just set by recordFailure)
    expect(entry.cooldownUntil).toBeGreaterThan(Date.now());

    expect(registry.isRecovering("cooling-provider")).toBe(false);
  });
});

describe("Thinking disable state", () => {
  it("disableThinking / isThinkingDisabled / enableThinking lifecycle", () => {
    const registry = new ProviderHealthRegistry();
    expect(registry.isThinkingDisabled("MiniMax")).toBe(false);
    registry.disableThinking("MiniMax");
    expect(registry.isThinkingDisabled("MiniMax")).toBe(true);
    expect(registry.isThinkingDisabled("minimax")).toBe(true); // normalized
    registry.enableThinking("MiniMax");
    expect(registry.isThinkingDisabled("MiniMax")).toBe(false);
  });

  it("requires 3 consecutive successes to re-enable", () => {
    const registry = new ProviderHealthRegistry();
    registry.disableThinking("test");
    expect(registry.recordThinkingSuccess("test")).toBe(false); // 1
    expect(registry.recordThinkingSuccess("test")).toBe(false); // 2
    expect(registry.recordThinkingSuccess("test")).toBe(true);  // 3 — threshold reached
  });

  it("resets success counter on failure", () => {
    const registry = new ProviderHealthRegistry();
    registry.disableThinking("test");
    registry.recordThinkingSuccess("test"); // 1
    registry.recordThinkingSuccess("test"); // 2
    registry.resetThinkingSuccessCounter("test"); // reset
    expect(registry.recordThinkingSuccess("test")).toBe(false); // back to 1
    expect(registry.recordThinkingSuccess("test")).toBe(false); // 2
    expect(registry.recordThinkingSuccess("test")).toBe(true);  // 3
  });

  it("clearProviderState removes all state including thinking", () => {
    const registry = new ProviderHealthRegistry();
    registry.disableThinking("test");
    registry.recordFailure("test", "some error");
    registry.clearProviderState("test");
    expect(registry.isThinkingDisabled("test")).toBe(false);
    expect(registry.isAvailable("test")).toBe(true);
  });
});
