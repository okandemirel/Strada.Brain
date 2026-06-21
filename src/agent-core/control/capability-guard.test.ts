/**
 * Agent Core v2 — CapabilityRegistry write-path guard tests (Phase 3b, ARCHITECTURE §7).
 * Covers classifyToolError (substrate vs tool-logic) and guardExecute (revive-once → BLOCKED,
 * heartbeat-through-revive, real-success heal, capability-failure cooling vs tool-logic passthrough).
 */

import { describe, it, expect, vi } from "vitest";
import { FakeClock } from "./clock.js";
import { CapabilityRegistry } from "./capability-registry.js";
import {
  classifyToolError,
  guardExecute,
  type CapabilityAdapter,
} from "./capability-guard.js";

const CAP = "unity-bridge";

function mkReg(config = {}) {
  return { clock: new FakeClock(0), reg: new CapabilityRegistry(new FakeClock(0), config) };
}

function downReg() {
  const reg = new CapabilityRegistry(new FakeClock(0), { downCooldownMs: 1000 });
  reg.register(CAP);
  for (let i = 0; i < 5; i++) reg.recordFailure(CAP, "boom"); // → down, still cooling (canAttempt false)
  return reg;
}

function mkAdapter(revived: boolean): CapabilityAdapter & { revive: ReturnType<typeof vi.fn> } {
  return { capabilityId: CAP, revive: vi.fn(async () => revived) };
}

describe("classifyToolError — substrate vs tool-logic", () => {
  it("a substrate CancelReason (provider-stall / hard-timeout) → capability-failure", () => {
    expect(classifyToolError(new Error("aborted"), { kind: "provider-stall", scope: "call" })).toBe(
      "capability-failure",
    );
    expect(classifyToolError(new Error("aborted"), { kind: "hard-timeout", scope: "call" })).toBe(
      "capability-failure",
    );
  });

  it("a transport/connection signature → capability-failure", () => {
    expect(classifyToolError(new Error("connect ECONNREFUSED 127.0.0.1:9000"))).toBe("capability-failure");
    expect(classifyToolError(new Error("socket hang up"))).toBe("capability-failure");
    expect(classifyToolError(new Error("fetch failed"))).toBe("capability-failure");
  });

  it("a plain tool error / non-substrate cancel reason → tool-logic (never cools a healthy cap)", () => {
    expect(classifyToolError(new Error("invalid argument: path required"))).toBe("tool-logic");
    expect(classifyToolError("file not found")).toBe("tool-logic");
    expect(classifyToolError(new Error("aborted"), { kind: "user-cancel" })).toBe("tool-logic");
    expect(classifyToolError(new Error("aborted"), { kind: "budget-exhausted", resource: "tokens" })).toBe(
      "tool-logic",
    );
  });

  it("a benign CancelReason is authoritative — NEVER capability-failure, even if the abort text looks transport-y", () => {
    // Regression guard: a benign cancel (sibling won / user / winddown) that tears down a connection
    // produces transport-y error text; the typed reason must win so a HEALTHY capability is not cooled
    // (cancel-reason.ts "benign never poisons health"). Before the fix, the text heuristic cooled it.
    expect(classifyToolError(new Error("connection closed"), { kind: "first-success-satisfied" })).toBe(
      "tool-logic",
    );
    expect(classifyToolError(new Error("socket hang up"), { kind: "user-cancel" })).toBe("tool-logic");
    expect(classifyToolError(new Error("ECONNRESET"), { kind: "task-winddown" })).toBe("tool-logic");
  });
});

describe("guardExecute — happy path", () => {
  it("a live capability runs directly (no revive) and a real success heals to live", async () => {
    const { reg } = mkReg();
    reg.register(CAP, "live");
    const emitHeartbeat = vi.fn();
    const res = await guardExecute({ registry: reg, capabilityId: CAP, run: async () => 42, emitHeartbeat });
    expect(res).toEqual({ kind: "ok", value: 42 });
    expect(reg.isLive(CAP)).toBe(true);
    expect(emitHeartbeat).not.toHaveBeenCalled(); // no revive on a live capability
  });

  it("a tool that RETURNS an error (not thrown) is tool-logic: ok result + the substrate heals to live", async () => {
    const { reg } = mkReg();
    reg.register(CAP); // unknown
    const toolResult = { isError: true, content: "compile error CS1002" };
    const res = await guardExecute({ registry: reg, capabilityId: CAP, run: async () => toolResult });
    expect(res).toEqual({ kind: "ok", value: toolResult }); // the call completed → substrate served
    expect(reg.isLive(CAP)).toBe(true);
  });
});

describe("guardExecute — revive-once on a down capability", () => {
  it("revive succeeds → degraded → run proceeds; heartbeat emitted around revive", async () => {
    const reg = downReg();
    expect(reg.canAttempt(CAP)).toBe(false); // down, cooling
    const adapter = mkAdapter(true);
    const emitHeartbeat = vi.fn();
    const res = await guardExecute({ registry: reg, capabilityId: CAP, adapter, emitHeartbeat, run: async () => "ok" });
    expect(res).toEqual({ kind: "ok", value: "ok" });
    expect(adapter.revive).toHaveBeenCalledTimes(1); // exactly once
    expect(emitHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(2); // before + after revive (never silent)
    expect(reg.isLive(CAP)).toBe(true); // the subsequent real success healed it fully
  });

  it("revive fails → BLOCKED(needs:cap); heartbeat still emitted", async () => {
    const reg = downReg();
    const adapter = mkAdapter(false);
    const emitHeartbeat = vi.fn();
    const res = await guardExecute({ registry: reg, capabilityId: CAP, adapter, emitHeartbeat, run: async () => "ok" });
    expect(res.kind).toBe("blocked");
    if (res.kind === "blocked") expect(res.blocked.needs).toBe(CAP);
    expect(adapter.revive).toHaveBeenCalledTimes(1);
    expect(emitHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("no adapter on a down capability → BLOCKED (cannot revive)", async () => {
    const reg = downReg();
    const res = await guardExecute({ registry: reg, capabilityId: CAP, run: async () => "ok" });
    expect(res.kind).toBe("blocked");
  });
});

describe("guardExecute — failure classification", () => {
  it("a capability-failure that knocks the substrate down → BLOCKED", async () => {
    const reg = new CapabilityRegistry(new FakeClock(0));
    reg.register(CAP);
    for (let i = 0; i < 4; i++) reg.recordFailure(CAP, "e"); // 4 failures → degraded, still attemptable
    expect(reg.canAttempt(CAP)).toBe(true);
    const res = await guardExecute({
      registry: reg,
      capabilityId: CAP,
      run: async () => {
        throw new Error("ECONNRESET"); // transport → capability-failure → 5th failure → down
      },
    });
    expect(res.kind).toBe("blocked");
    if (res.kind === "blocked") expect(res.blocked.needs).toBe(CAP);
  });

  it("a tool-logic error rethrows and leaves capability health UNCHANGED", async () => {
    const { reg } = mkReg();
    reg.register(CAP, "live");
    await expect(
      guardExecute({
        registry: reg,
        capabilityId: CAP,
        run: async () => {
          throw new Error("invalid argument");
        },
      }),
    ).rejects.toThrow("invalid argument");
    expect(reg.isLive(CAP)).toBe(true); // not cooled — tool-logic doesn't touch capability health
  });

  it("a transient capability blip below the down threshold rethrows (not yet BLOCKED)", async () => {
    const { reg } = mkReg();
    reg.register(CAP, "live");
    await expect(
      guardExecute({
        registry: reg,
        capabilityId: CAP,
        run: async () => {
          throw new Error("ETIMEDOUT"); // capability-failure, but 1st → below downThreshold
        },
      }),
    ).rejects.toThrow("ETIMEDOUT");
    expect(reg.canAttempt(CAP)).toBe(true); // still attemptable (a single blip)
    expect(reg.getState(CAP)?.consecutiveFailures).toBe(1);
  });
});
