import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A real ProviderManager logs through getLogger(), which throws uninitialised.
vi.mock("../../../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/logger.js")>();
  const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  return { ...actual, getLogger: () => quiet, getLoggerSafe: () => quiet };
});

import { DelegationManager } from "./delegation-manager.js";
import { ProviderManager } from "../../providers/provider-manager.js";
import type { IAIProvider } from "../../providers/provider.interface.js";

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

  it("the TIER MAP does not outrank the chain either (measured live 2026-09-12 02:13)", () => {
    // The candidate pool respected the chain and delegated turns still went to
    // a provider outside it: the tier router's configured name is consulted
    // first, before the pool is ever built.
    const manager = Object.create(DelegationManager.prototype) as DelegationManager;
    (manager as unknown as { opts: unknown }).opts = {
      providerCredentials: { opencode: { apiKey: "a" }, openai: { apiKey: "c" } },
      providerModels: {},
      providerChain: ["opencode"],
      chainIsExhaustive: true,
      tierRouter: { resolveProviderConfig: () => ({ name: "openai", model: "gpt-x" }) },
    };
    (manager as unknown as { isDelegationProviderAvailable: (n: string) => boolean }).isDelegationProviderAvailable = () => true;
    (manager as unknown as { getDefaultModelForProvider: (n: string) => string }).getDefaultModelForProvider = () => "m";
    (manager as unknown as { buildDelegationProviderConfig: (n: string, m: string) => unknown }).buildDelegationProviderConfig =
      (name: string) => ({ name, apiKey: "k", model: "m", baseUrl: "https://example.test/v1" });
    (manager as unknown as { inferDelegationWorkload: () => string }).inferDelegationWorkload = () => "general";
    (manager as unknown as { scoreDelegationCandidate: () => number }).scoreDelegationCandidate = () => 1;

    const resolved = (manager as unknown as {
      resolveDelegationProviderConfig(tier: string, cfg: unknown): { name: string };
    }).resolveDelegationProviderConfig("standard", { name: "code_review" });

    expect(resolved.name).toBe("opencode");
  });
});

/**
 * Each sub-agent gets its own ProviderManager over the deployment's shared
 * preferences DB. It was built with no chain and not strict, so a chat with no
 * preference of its own fell back to the brain-wide default — which a pick of
 * "openai" in any other chat writes — and the delegated run was routed on
 * OpenAI while the strict main manager kept to the chain (review 2026-10-11,
 * reproduced: chain(OpenAI) from the delegate's manager).
 */
describe("a delegated sub-agent's own ProviderManager obeys the strict chain", () => {
  let prefsDir: string;
  const managers: ProviderManager[] = [];
  beforeEach(() => { prefsDir = mkdtempSync(join(tmpdir(), "deleg-prefs-")); });
  afterEach(() => {
    for (const m of managers.splice(0)) m.shutdown();
    rmSync(prefsDir, { recursive: true, force: true });
  });

  const credentials = { opencode: { apiKey: "a" }, opencode2: { apiKey: "b" }, openai: { apiKey: "c" } };
  const tierProvider = { name: "opencode", capabilities: { vision: false } } as unknown as IAIProvider;

  const subAgentManager = (opts: Record<string, unknown>): ProviderManager => {
    const manager = Object.create(DelegationManager.prototype) as DelegationManager;
    (manager as unknown as { opts: unknown }).opts = {
      providerCredentials: credentials,
      providerModels: {},
      preferencesDbPath: prefsDir,
      ...opts,
    };
    const built = (manager as unknown as {
      buildSubAgentProviderManager(provider: IAIProvider, name: string): ProviderManager;
    }).buildSubAgentProviderManager(tierProvider, "opencode");
    managers.push(built);
    return built;
  };

  /** Someone picked OpenAI in a chat; setPreference mirrors it to the brain-wide default. */
  const pickOpenAiElsewhere = (): void => {
    const main = new ProviderManager(tierProvider, credentials, {}, prefsDir, ["opencode", "opencode2"], undefined, undefined, undefined, true);
    managers.push(main);
    main.setPreference("web-chat-1", "openai");
  };

  it("routes the delegate's chat on the chain, not on a brain-wide default outside it", () => {
    pickOpenAiElsewhere();
    const pm = subAgentManager({ providerChain: ["opencode", "opencode2"], chainIsExhaustive: true });

    const routed = pm.getProvider("delegation-sub-1");

    expect(routed, `routed on ${routed.name}`).toBe(tierProvider);
    expect(pm.allowsProvider("openai")).toBe(false);
    expect(pm.allowsProvider("opencode2")).toBe(true);
  });

  it("leaves a deployment without a strict chain exactly as it was", () => {
    pickOpenAiElsewhere();
    const pm = subAgentManager({ providerChain: ["opencode"], chainIsExhaustive: false });

    expect(pm.getProvider("delegation-sub-1")).not.toBe(tierProvider);
    expect(pm.allowsProvider("openai")).toBe(true);
  });
});
