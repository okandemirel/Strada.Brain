import { describe, expect, it, afterEach } from "vitest";
import { allProvidersCoolingDownMs, setLiveChainMemberNames } from "./provider-outage.js";
import { ProviderHealthRegistry } from "./provider-health.js";

const registry = ProviderHealthRegistry.getInstance();

afterEach(() => {
  setLiveChainMemberNames([]);
  for (const name of ["p-cool", "p-fresh", "p-other"]) registry.clearProviderState(name);
});

describe("allProvidersCoolingDownMs", () => {
  it("a declared chain member with NO health entry is available capacity", () => {
    // Measured live 2026-08-31: two fresh accounts had never been dialed, so
    // they had no registry entries; the measure walked entries only and
    // called a partial outage a full one, parking the campaign.
    registry.recordOverloaded("p-cool", "quota");
    setLiveChainMemberNames(["p-cool", "p-fresh"]);
    expect(allProvidersCoolingDownMs()).toBe(0);
  });

  it("still reports the wait when every declared member is cooling", () => {
    registry.recordOverloaded("p-cool", "quota");
    registry.recordOverloaded("p-other", "quota");
    setLiveChainMemberNames(["p-cool", "p-other"]);
    expect(allProvidersCoolingDownMs()).toBeGreaterThan(0);
  });

  it("an available member short-circuits to 0", () => {
    registry.recordOverloaded("p-cool", "quota");
    registry.recordSuccess("p-other");
    setLiveChainMemberNames(["p-cool", "p-other"]);
    expect(allProvidersCoolingDownMs()).toBe(0);
  });
});
