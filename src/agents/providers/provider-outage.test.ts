import { describe, expect, it, afterEach } from "vitest";
import { allProvidersCoolingDownMs, LAPSED_DOWN_GRACE_MS, msSinceNewestProviderFailure, setLiveChainMemberNames } from "./provider-outage.js";
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

  it("a member whose cooldown lapsed reads as down only for a short grace, then as capacity to probe", () => {
    // Measured 2026-09-08 03:02: the only live member lapsed at 03:01 and
    // nothing dialed it while the campaign was parked; the measure fell
    // through to the next member's Sep 11 horizon and re-parked for 3 days.
    registry.recordOverloaded("p-cool", "quota");
    registry.recordOverloaded("p-other", "quota");
    setLiveChainMemberNames(["p-cool", "p-other"]);
    const entry = registry.getAllEntries().get("p-cool") as unknown as { cooldownUntil: number };
    entry.cooldownUntil = Date.now() - 5_000; // lapsed 5 s ago, still "down"
    const wait = allProvidersCoolingDownMs();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(LAPSED_DOWN_GRACE_MS);
    entry.cooldownUntil = Date.now() - 5 * 60_000; // lapsed five minutes ago
    expect(allProvidersCoolingDownMs()).toBe(0);
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

describe("msSinceNewestProviderFailure", () => {
  it("is Infinity with no failure on record, and the age of the newest chain member failure otherwise — a probe success does not erase it", () => {
    // Measured 2026-09-08 06:58: stalls, then a passing 40-token probe, then
    // coolingMs 0 — the failure had happened minutes earlier all the same.
    setLiveChainMemberNames(["p-cool", "p-other"]);
    expect(msSinceNewestProviderFailure()).toBe(Number.POSITIVE_INFINITY);
    registry.recordFailure("p-cool", "provider-stall");
    const t = Date.now();
    expect(msSinceNewestProviderFailure(t + 90_000)).toBeGreaterThanOrEqual(90_000);
    expect(msSinceNewestProviderFailure(t + 90_000)).toBeLessThan(95_000);
    registry.recordSuccess("p-cool", "probe");
    expect(msSinceNewestProviderFailure(t + 90_000)).toBeLessThan(95_000);
    // A REAL success after the failure means the provider answered since:
    // that failure no longer explains a later stall (Codex review 2026-09-08:
    // healthy provider, 20-minute tool hang, read as an outage).
    registry.recordSuccess("p-cool");
    expect(msSinceNewestProviderFailure(t + 90_000)).toBe(Number.POSITIVE_INFINITY);
    // A failure on a provider outside the live chain is not this chain's outage.
    registry.recordFailure("p-fresh", "boom");
    setLiveChainMemberNames(["p-other"]);
    expect(msSinceNewestProviderFailure()).toBe(Number.POSITIVE_INFINITY);
  });
});
