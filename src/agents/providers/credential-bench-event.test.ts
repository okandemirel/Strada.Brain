import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProviderHealthRegistry, type CredentialBenchEvent } from "./provider-health.js";

const HOUR_MS = 60 * 60 * 1000;

describe("ProviderHealthRegistry credential bench event", () => {
  let registry: ProviderHealthRegistry;
  let heard: CredentialBenchEvent[];

  beforeEach(() => {
    ProviderHealthRegistry.resetInstance();
    registry = ProviderHealthRegistry.getInstance();
    heard = [];
    registry.onCredentialBench((e) => heard.push(e));
  });

  it("announces a refused key once, with the seat, the reason, the bench length and who carries on", () => {
    registry.recordCredentialRejected("alpha", "alpha API error 401: invalid api key\nsecond line", "beta");
    expect(heard).toEqual([
      { provider: "alpha", reason: "alpha API error 401: invalid api key", benchedForMs: 8 * HOUR_MS, continuingOn: "beta" },
    ]);
  });

  it("says nothing when the seat is already benched: the user is told once per session", () => {
    registry.recordCredentialRejected("alpha", "401", "beta");
    registry.recordCredentialRejected("alpha", "401 again", "beta");
    expect(heard).toHaveLength(1);
  });

  it("announces nothing for a cooldown that heals on its own", () => {
    registry.recordOverloadedShort("alpha", "503");
    registry.recordFailure("alpha", "overloaded 529");
    expect(heard).toEqual([]);
  });

  it("omits continuingOn when no seat is left, and masks secrets in the reason", () => {
    registry.recordCredentialRejected("alpha", "401 key sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD rejected");
    expect(heard).toHaveLength(1);
    expect("continuingOn" in heard[0]!).toBe(false);
    expect(heard[0]!.reason).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("a listener that throws never stops the bench, and a later listener still hears it", () => {
    const unsubscribe = registry.onCredentialBench(() => { throw new Error("listener broke"); });
    const later = vi.fn();
    registry.onCredentialBench(later);
    registry.recordCredentialRejected("alpha", "401", "beta");
    expect(registry.isAvailable("alpha")).toBe(false);
    expect(later).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("stops announcing to a listener that unsubscribed", () => {
    const quiet = vi.fn();
    registry.onCredentialBench(quiet)();
    registry.recordCredentialRejected("alpha", "401", "beta");
    expect(quiet).not.toHaveBeenCalled();
  });
});
