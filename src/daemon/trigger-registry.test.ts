import { describe, it, expect, beforeEach } from "vitest";
import { TriggerRegistry } from "./trigger-registry.js";
import type { ITrigger, TriggerMetadata, TriggerState } from "./daemon-types.js";

/** Minimal mock trigger for testing */
function makeTrigger(name: string, state: TriggerState = "active"): ITrigger {
  const metadata: TriggerMetadata = {
    name,
    description: `Test trigger: ${name}`,
    type: "cron",
  };
  return {
    metadata,
    shouldFire: () => false,
    onFired: () => {},
    getNextRun: () => null,
    getState: () => state,
  };
}

describe("TriggerRegistry", () => {
  let registry: TriggerRegistry;

  beforeEach(() => {
    registry = new TriggerRegistry();
  });

  // =========================================================================
  // Register / getAll
  // =========================================================================

  it("register adds a trigger, getAll returns it", () => {
    const trigger = makeTrigger("daily-check");
    registry.register(trigger);
    const all = registry.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].metadata.name).toBe("daily-check");
  });

  it("register with duplicate name throws", () => {
    const trigger1 = makeTrigger("daily-check");
    const trigger2 = makeTrigger("daily-check");
    registry.register(trigger1);
    expect(() => registry.register(trigger2)).toThrow(/already registered/i);
  });

  // =========================================================================
  // Unregister
  // =========================================================================

  it("unregister removes a trigger", () => {
    const trigger = makeTrigger("to-remove");
    registry.register(trigger);
    expect(registry.count()).toBe(1);

    registry.unregister("to-remove");
    expect(registry.count()).toBe(0);
    expect(registry.getByName("to-remove")).toBeUndefined();
  });

  // =========================================================================
  // getActive
  // =========================================================================

  it("getActive returns only non-disabled triggers", () => {
    registry.register(makeTrigger("active-1", "active"));
    registry.register(makeTrigger("disabled-1", "disabled"));
    registry.register(makeTrigger("paused-1", "paused"));
    registry.register(makeTrigger("backed-off-1", "backed_off"));

    const active = registry.getActive();
    expect(active).toHaveLength(3);
    const names = active.map((t) => t.metadata.name);
    expect(names).toContain("active-1");
    expect(names).toContain("paused-1");
    expect(names).toContain("backed-off-1");
    expect(names).not.toContain("disabled-1");
  });

  // =========================================================================
  // getByName
  // =========================================================================

  it("getByName returns specific trigger or undefined", () => {
    const trigger = makeTrigger("lookup-test");
    registry.register(trigger);

    expect(registry.getByName("lookup-test")).toBe(trigger);
    expect(registry.getByName("non-existent")).toBeUndefined();
  });

  // =========================================================================
  // Clear
  // =========================================================================

  it("clear removes all triggers", () => {
    registry.register(makeTrigger("a"));
    registry.register(makeTrigger("b"));
    registry.register(makeTrigger("c"));
    expect(registry.count()).toBe(3);

    registry.clear();
    expect(registry.count()).toBe(0);
    expect(registry.getAll()).toHaveLength(0);
  });

  // =========================================================================
  // Count
  // =========================================================================

  it("count returns current trigger count", () => {
    expect(registry.count()).toBe(0);
    registry.register(makeTrigger("a"));
    expect(registry.count()).toBe(1);
    registry.register(makeTrigger("b"));
    expect(registry.count()).toBe(2);
    registry.unregister("a");
    expect(registry.count()).toBe(1);
  });
});
