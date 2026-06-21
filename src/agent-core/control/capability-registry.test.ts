/**
 * Agent Core v2 — CapabilityRegistry state-machine tests (Phase 3b core, ARCHITECTURE §7).
 * Deterministic under the injected FakeClock — covers the live/degraded/down/unknown transitions,
 * probe-heals-to-degraded vs real-heals-to-live, the escalating cooldown, cooldown auto-recovery,
 * the advertise decision, and the BLOCKED contract.
 */

import { describe, it, expect } from "vitest";
import { FakeClock } from "./clock.js";
import {
  CapabilityRegistry,
  DEFAULT_CAPABILITY_CONFIG,
  buildBlocked,
  formatBlocked,
} from "./capability-registry.js";

function mk(config = {}) {
  const clock = new FakeClock(0);
  const reg = new CapabilityRegistry(clock, config);
  return { clock, reg };
}

const CAP = "unity-bridge";

describe("CapabilityRegistry — registration + initial status", () => {
  it("defaults to unknown; in-process capabilities register live; re-register is idempotent", () => {
    const { reg } = mk();
    reg.register(CAP);
    expect(reg.getState(CAP)?.status).toBe("unknown");
    reg.register("in-process", "live");
    expect(reg.isLive("in-process")).toBe(true);
    // re-register does not reset
    reg.recordRealSuccess(CAP); // → live
    reg.register(CAP); // idempotent — must NOT reset to unknown
    expect(reg.isLive(CAP)).toBe(true);
  });

  it("an unregistered capability is effectively unknown / not advertisable", () => {
    const { reg } = mk();
    expect(reg.effectiveStatus("never-seen")).toBe("unknown");
    expect(reg.advertisement("never-seen")).toEqual({ advertise: false, warn: false });
    expect(reg.isLive("never-seen")).toBe(false);
  });
});

describe("CapabilityRegistry — healing (probe → degraded, real → live)", () => {
  it("a real success heals fully to live and clears escalation", () => {
    const { reg } = mk();
    reg.register(CAP);
    for (let i = 0; i < 5; i++) reg.recordFailure(CAP, "boom"); // → down, downEpisodes=1
    expect(reg.getState(CAP)?.status).toBe("down");
    reg.recordRealSuccess(CAP);
    const s = reg.getState(CAP)!;
    expect(s.status).toBe("live");
    expect(s.consecutiveFailures).toBe(0);
    expect(s.downEpisodes).toBe(0); // cleared — real success is proof
  });

  it("a probe success heals only to degraded and KEEPS downEpisodes (not proof of health)", () => {
    const { reg } = mk();
    reg.register(CAP);
    for (let i = 0; i < 5; i++) reg.recordFailure(CAP, "boom"); // → down, downEpisodes=1
    reg.recordProbeSuccess(CAP);
    const s = reg.getState(CAP)!;
    expect(s.status).toBe("degraded");
    expect(s.downEpisodes).toBe(1); // escalation persists across a probe
  });

  it("a probe never downgrades an already-live capability", () => {
    const { reg } = mk();
    reg.register(CAP, "live");
    reg.recordProbeSuccess(CAP);
    expect(reg.getState(CAP)?.status).toBe("live");
  });

  it("a probe-healed capability is advertisable (degraded+warn), NOT silently withheld", () => {
    // Regression guard: a probe heal leaves cooldownUntil=0 ("usable now"); effectiveStatus must keep
    // it `degraded` rather than reconsidering a cooldownUntil=0 entry as `unknown` (which would
    // withhold a probe-proven tool from the prompt — contra §7 "degraded → advertise with warning").
    const { reg } = mk();
    reg.register(CAP);
    for (let i = 0; i < 5; i++) reg.recordFailure(CAP, "boom"); // → down
    reg.recordProbeSuccess(CAP); // → degraded, cooldownUntil 0
    expect(reg.effectiveStatus(CAP)).toBe("degraded");
    expect(reg.advertisement(CAP)).toEqual({ advertise: true, warn: true });
    expect(reg.canAttempt(CAP)).toBe(true);
  });
});

describe("CapabilityRegistry — failure escalation + cooldown", () => {
  it("escalates unknown → degraded (at degradedThreshold) → down (at downThreshold)", () => {
    const { reg } = mk();
    reg.register(CAP);
    reg.recordFailure(CAP, "e"); // 1 — below degradedThreshold(2): status unchanged
    expect(reg.getState(CAP)?.status).toBe("unknown");
    reg.recordFailure(CAP, "e"); // 2 → degraded
    expect(reg.getState(CAP)?.status).toBe("degraded");
    reg.recordFailure(CAP, "e"); // 3
    reg.recordFailure(CAP, "e"); // 4
    reg.recordFailure(CAP, "e"); // 5 → down
    expect(reg.getState(CAP)?.status).toBe("down");
  });

  it("a sub-threshold failure does not degrade a live capability", () => {
    const { reg } = mk();
    reg.register(CAP, "live");
    reg.recordFailure(CAP, "transient"); // 1 failure, below degradedThreshold
    expect(reg.getState(CAP)?.status).toBe("live");
    expect(reg.getState(CAP)?.consecutiveFailures).toBe(1);
  });

  it("the down cooldown doubles per down episode (escalating, capped)", () => {
    const { reg } = mk({ downCooldownMs: 1000, maxCooldownMs: 100_000 });
    reg.register(CAP);
    for (let i = 0; i < 5; i++) reg.recordFailure(CAP, "e"); // 5th → down, episode 0 → cooldown 1000
    expect(reg.getState(CAP)?.cooldownUntil).toBe(1000);
    expect(reg.getState(CAP)?.downEpisodes).toBe(1);
    reg.recordFailure(CAP, "e"); // 6th, still ≥downThreshold → episode 1 → cooldown 1000*2 = 2000
    expect(reg.getState(CAP)?.cooldownUntil).toBe(2000);
    expect(reg.getState(CAP)?.downEpisodes).toBe(2);
  });

  it("a down capability auto-recovers to unknown after its cooldown elapses", () => {
    const { clock, reg } = mk({ downCooldownMs: 1000 });
    reg.register(CAP);
    for (let i = 0; i < 5; i++) reg.recordFailure(CAP, "e"); // → down, cooldownUntil = 1000
    expect(reg.effectiveStatus(CAP)).toBe("down");
    clock.advance(999);
    expect(reg.effectiveStatus(CAP)).toBe("down"); // still cooling
    clock.advance(2); // now past 1000
    expect(reg.effectiveStatus(CAP)).toBe("unknown"); // eligible for re-probe/revive
  });
});

describe("CapabilityRegistry — advertise decision + canAttempt", () => {
  it("live → advertise; degraded → advertise+warn; down/unknown → withhold", () => {
    const { reg } = mk();
    reg.register("live-cap", "live");
    expect(reg.advertisement("live-cap")).toEqual({ advertise: true, warn: false });

    reg.register("deg-cap");
    reg.recordFailure("deg-cap", "e");
    reg.recordFailure("deg-cap", "e"); // → degraded
    expect(reg.advertisement("deg-cap")).toEqual({ advertise: true, warn: true });

    reg.register("down-cap");
    for (let i = 0; i < 5; i++) reg.recordFailure("down-cap", "e"); // → down
    expect(reg.advertisement("down-cap")).toEqual({ advertise: false, warn: false });
    expect(reg.advertisement("unknown-cap")).toEqual({ advertise: false, warn: false });
  });

  it("canAttempt is false only for a still-cooling down capability", () => {
    const { clock, reg } = mk({ downCooldownMs: 1000 });
    reg.register(CAP, "live");
    expect(reg.canAttempt(CAP)).toBe(true);
    for (let i = 0; i < 5; i++) reg.recordFailure(CAP, "e"); // → down
    expect(reg.canAttempt(CAP)).toBe(false);
    clock.advance(1001); // cooled down → eligible for the revive-once attempt
    expect(reg.canAttempt(CAP)).toBe(true);
  });
});

describe("CapabilityRegistry — BLOCKED contract", () => {
  it("buildBlocked + formatBlocked produce the stable parseable wire shape", () => {
    const withFeature = buildBlocked("unity-bridge", "bridge disconnected", "compile");
    expect(withFeature).toMatchObject({
      kind: "blocked",
      capability: "unity-bridge",
      feature: "compile",
      needs: "unity-bridge#compile",
    });
    expect(formatBlocked(withFeature)).toBe("BLOCKED needs=unity-bridge#compile — bridge disconnected");

    const noFeature = buildBlocked("network", "offline");
    expect(noFeature.needs).toBe("network");
    expect(noFeature.feature).toBeUndefined();
    expect(formatBlocked(noFeature)).toBe("BLOCKED needs=network — offline");
  });

  it("DEFAULT_CAPABILITY_CONFIG mirrors the ProviderHealthRegistry thresholds", () => {
    expect(DEFAULT_CAPABILITY_CONFIG.degradedThreshold).toBe(2);
    expect(DEFAULT_CAPABILITY_CONFIG.downThreshold).toBe(5);
  });
});
