import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { DelegationManager } from "./delegation-manager.js";

/**
 * Measured live 2026-09-12 01:34: a project pinned to "opencode,opencode2"
 * with PROVIDER_CHAIN_STRICT=1 ran its sprint turns on OpenAI. The routing
 * fix (review O) closed the main chain; delegation built its candidate pool
 * from every credential in the environment, so an account reserved for other
 * work was still a sub-agent worker.
 */
describe("a strict chain governs sub-agents too", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); });

  const candidates = (opts: Record<string, unknown>): string[] => {
    const manager = Object.create(DelegationManager.prototype) as DelegationManager;
    (manager as unknown as { opts: unknown }).opts = {
      providerCredentials: { opencode: { apiKey: "a" }, opencode2: { apiKey: "b" }, openai: { apiKey: "c" } },
      providerModels: {},
      ...opts,
    };
    (manager as unknown as { isDelegationProviderAvailable: (n: string) => boolean }).isDelegationProviderAvailable = () => true;
    (manager as unknown as { getDefaultModelForProvider: (n: string) => string }).getDefaultModelForProvider = () => "m";
    (manager as unknown as { buildDelegationProviderConfig: (n: string, m: string) => unknown }).buildDelegationProviderConfig =
      (name: string) => ({ name, apiKey: "k", model: "m", baseUrl: "https://example.test/v1" });
    return (manager as unknown as { buildDelegationCandidates(): Array<{ name: string }> })
      .buildDelegationCandidates()
      .map((c) => c.name)
      .sort();
  };

  it("keeps a provider outside the strict chain out of the pool", () => {
    expect(candidates({ providerChain: ["opencode", "opencode2"], chainIsExhaustive: true }))
      .toEqual(["opencode", "opencode2"]);
  });

  it("leaves an unpinned deployment exactly as it was", () => {
    expect(candidates({})).toEqual(["opencode", "opencode2", "openai"].sort());
    expect(candidates({ providerChain: ["opencode"], chainIsExhaustive: false }))
      .toEqual(["opencode", "opencode2", "openai"].sort());
  });
});
