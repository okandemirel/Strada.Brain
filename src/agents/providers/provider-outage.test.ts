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

describe("sibling accounts keep distinct identities", () => {
  it("createProvider labels each registry name separately (opencode vs opencode2)", async () => {
    // Measured 2026-08-31: OpencodeProvider hardcoded its label, so all three
    // accounts shared one health identity — account #1's 8h quota cooldown
    // suppressed two fresh accounts and the chain called a full outage.
    const { createProvider } = await import("./provider-registry.js");
    const a = createProvider({ name: "opencode", apiKey: "sk-a" });
    const b = createProvider({ name: "opencode2", apiKey: "sk-b" });
    const c = createProvider({ name: "opencode3", apiKey: "sk-c" });
    expect(a.name).not.toBe(b.name);
    expect(b.name).not.toBe(c.name);
  });
});
