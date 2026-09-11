import { describe, expect, it, vi } from "vitest";

import { ProviderManager } from "./provider-manager.js";

/**
 * Measured live 2026-09-12 02:24: with routing, the delegation pool and the
 * tier map all respecting PROVIDER_CHAIN_STRICT, delegated turns STILL went to
 * a provider outside the chain — the supervisor's per-node assigner asks
 * "which providers exist here", and every credential in the environment
 * answered yes.
 */
describe("what may route, as opposed to what exists", () => {
  const manager = (order: string[], strict: boolean): ProviderManager => {
    const m = Object.create(ProviderManager.prototype) as ProviderManager;
    (m as unknown as { defaultProviderOrder: readonly string[] }).defaultProviderOrder = order;
    (m as unknown as { chainIsExhaustive: boolean }).chainIsExhaustive = strict;
    (m as unknown as { listAvailable: () => unknown }).listAvailable = () => [
      { name: "opencode", label: "OpenCode", defaultModel: "a" },
      { name: "opencode2", label: "OpenCode #2", defaultModel: "b" },
      { name: "openai", label: "OpenAI", defaultModel: "c" },
    ];
    return m;
  };

  it("offers only the chain when the chain is exhaustive", () => {
    expect(manager(["opencode", "opencode2"], true).listRoutable().map((p) => p.name))
      .toEqual(["opencode", "opencode2"]);
  });

  it("offers everything when the operator pinned nothing", () => {
    expect(manager([], false).listRoutable().map((p) => p.name))
      .toEqual(["opencode", "opencode2", "openai"]);
    expect(manager(["opencode"], false).listRoutable()).toHaveLength(3);
  });

  it("never returns an empty pool: a chain nothing matches falls back", () => {
    // An unsatisfiable routing pool is worse than a named gap.
    expect(manager(["nothing-here"], true).listRoutable()).toHaveLength(3);
  });
});
