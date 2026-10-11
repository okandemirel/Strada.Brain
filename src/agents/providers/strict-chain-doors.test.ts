import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAIProvider } from "./provider.interface.js";

/**
 * PROVIDER_CHAIN_STRICT: no provider outside the operator's chain is ever
 * handed out. Audited 2026-10 (providers#2, #6): with the chain set to
 * opencode,opencode2 and the OpenAI subscription still configured for other
 * work, the vision door returned a bare OpenAI provider for every
 * visual-conformance check, the by-name primary door built OpenAI for
 * supervisor planning, and the by-name chain door answered "openai" with the
 * OpenCode chain — so a "cross-provider" review was OpenCode reviewing itself.
 */

const { preferenceState, buildProviderChainMock } = vi.hoisted(() => ({
  preferenceState: new Map<string, {
    providerName: string;
    model?: string;
    selectionMode: "strada-preference-bias" | "strada-hard-pin";
  }>(),
  buildProviderChainMock: vi.fn(),
}));

function makeProvider(name: string): IAIProvider {
  return {
    name,
    capabilities: {
      maxTokens: 4096,
      streaming: true,
      structuredStreaming: false,
      toolCalling: true,
      vision: true,
      systemPrompt: true,
    },
    chat: vi.fn(),
  };
}

vi.mock("./provider-registry.js", () => ({
  // The real registry lists openai first, ahead of the OpenCode seats.
  PROVIDER_PRESETS: {
    openai: { baseUrl: "https://example.test/openai", defaultModel: "gpt-5.4", label: "OpenAI" },
    opencode: { baseUrl: "https://example.test/opencode", defaultModel: "oc-a", label: "OpenCode" },
    opencode2: { baseUrl: "https://example.test/opencode2", defaultModel: "oc-b", label: "OpenCode #2" },
  },
  buildProviderChain: buildProviderChainMock,
  createProvider: vi.fn(({ name }: { name: string }) => makeProvider(name)),
}));

vi.mock("./provider-preferences.js", () => ({
  ProviderPreferenceStore: vi.fn().mockImplementation(function () {
    return {
      initialize: vi.fn(),
      get: vi.fn((chatId: string) => preferenceState.get(chatId)),
      set: vi.fn(),
      delete: vi.fn(),
      getMostRecent: vi.fn(() => undefined),
      close: vi.fn(),
    };
  }),
}));

vi.mock("../../utils/logger.js", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { getLoggerSafe: () => log, getLogger: () => log };
});

import { ProviderManager } from "./provider-manager.js";
import { ProviderHealthRegistry } from "./provider-health.js";

const CREDENTIALS = {
  openai: { apiKey: "openai-key" },
  opencode: { apiKey: "oc-key" },
  opencode2: { apiKey: "oc2-key" },
};

function manager(strict: boolean): ProviderManager {
  return new ProviderManager(
    makeProvider("chain(opencode->opencode2)"),
    CREDENTIALS,
    undefined,
    "/tmp/strict-chain-doors-test",
    ["opencode", "opencode2"],
    undefined,
    undefined,
    undefined,
    strict,
  );
}

describe("a strict chain hands out no provider outside it", () => {
  beforeEach(() => {
    ProviderHealthRegistry.resetInstance();
    preferenceState.clear();
    buildProviderChainMock.mockReset();
    buildProviderChainMock.mockImplementation((order: string[]) => makeProvider(`chain(${order.join("->")})`));
  });

  it("the vision door picks a seeing provider inside the chain, never the excluded account", () => {
    const vision = manager(true).getVisionProvider();
    expect(vision?.name).toBe("opencode");
    expect(vision?.provider.name).toBe("opencode");
  });

  it("the by-name primary door refuses an excluded provider", () => {
    const m = manager(true);
    expect(m.getPrimaryProviderByName("openai", "gpt-5.4")).toBeNull();
    expect(m.getPrimaryProviderByName("opencode2")?.name).toBe("opencode2");
  });

  it("the by-name chain door refuses an excluded provider instead of answering with the chain under its name", () => {
    const m = manager(true);
    expect(m.getProviderByName("openai")).toBeNull();
    expect(m.getProviderByName("openai", "gpt-5.4")).toBeNull();
    expect(m.getProviderByName("opencode2")).not.toBeNull();
  });

  it("a stored preference for an excluded provider is reported as what actually runs", () => {
    preferenceState.set("chat-1", { providerName: "openai", model: "gpt-5.4", selectionMode: "strada-preference-bias" });
    preferenceState.set("chat-2", { providerName: "openai", model: "gpt-5.4", selectionMode: "strada-hard-pin" });
    const m = manager(true);
    for (const chat of ["chat-1", "chat-2"]) {
      const info = m.getActiveInfo(chat);
      expect(info.providerName, chat).toBe("opencode");
      expect(info.selectionMode, chat).toBe("strada-preference-bias");
    }
    // The execution pool a hard pin outside the chain offers is the chain.
    expect(m.listExecutionCandidates("chat-2").map((c) => c.name)).toEqual(["opencode", "opencode2"]);
  });

  it("the model catalog does not list the chain's models under an excluded provider's name", async () => {
    const chain = {
      ...makeProvider("chain(opencode->opencode2)"),
      listModels: vi.fn(async () => ["oc-a", "oc-b"]),
    };
    const m = new ProviderManager(
      chain, CREDENTIALS, undefined, "/tmp/strict-chain-doors-test", ["opencode", "opencode2"],
      undefined, undefined, undefined, true,
    );
    const openai = (await m.listAvailableWithModels()).find((p) => p.name === "openai");
    expect(openai?.models).toEqual(["gpt-5.4"]);
  });

  it("an unpinned deployment still reaches every credentialed provider", () => {
    const m = manager(false);
    expect(m.getVisionProvider()?.name).toBe("openai");
    expect(m.getPrimaryProviderByName("openai")?.name).toBe("openai");
    expect(m.getProviderByName("openai")).not.toBeNull();
  });
});

/**
 * "anthropic" and "claude" are both accepted chain names and both canonical,
 * but the Claude seat lists itself as "claude". The strict gate compared
 * spellings, so PROVIDER_CHAIN=anthropic shut its own only seat out: no vision
 * provider (visual conformance read "not checked" with a false reason), no
 * by-name lookup of the seat as "claude", and
 * listRoutable fell back to every credential, the excluded account included.
 */
describe("a strict chain admits its seat under either Claude spelling", () => {
  const CLAUDE_CREDENTIALS = {
    claude: { apiKey: "anthropic-key" },
    anthropic: { apiKey: "anthropic-key" },
    openai: { apiKey: "openai-key" },
  };
  const claudeManager = (chain: string[], strict = true): ProviderManager => new ProviderManager(
    makeProvider(`chain(${chain.join("->")})`),
    CLAUDE_CREDENTIALS,
    undefined,
    "/tmp/strict-chain-doors-test",
    chain,
    undefined,
    undefined,
    undefined,
    strict,
  );

  beforeEach(() => {
    ProviderHealthRegistry.resetInstance();
    preferenceState.clear();
    buildProviderChainMock.mockReset();
    buildProviderChainMock.mockImplementation((order: string[]) => makeProvider(`chain(${order.join("->")})`));
  });

  it.each(["anthropic", "claude", "Anthropic Claude"])("PROVIDER_CHAIN=%s opens every door to the Claude seat and none to openai", (spelling) => {
    const m = claudeManager([spelling]);
    for (const name of ["claude", "anthropic"]) {
      expect(m.allowsProvider(name), name).toBe(true);
      expect(m.getPrimaryProviderByName(name), name).not.toBeNull();
      expect(m.getProviderByName(name), name).not.toBeNull();
    }
    expect(m.getVisionProvider()?.name).toBe("claude");
    expect(m.listRoutable().map((p) => p.name)).toEqual(["claude"]);
    expect(m.allowsProvider("openai")).toBe(false);
    expect(m.getPrimaryProviderByName("openai")).toBeNull();
    expect(m.getProviderByName("openai")).toBeNull();
  });

  it("a preference under the other spelling is what runs, reported and pooled as itself", () => {
    preferenceState.set("chat-1", { providerName: "claude", model: "claude-x", selectionMode: "strada-hard-pin" });
    const m = claudeManager(["anthropic"]);
    const info = m.getActiveInfo("chat-1");
    expect(info.providerName).toBe("claude");
    expect(info.model).toBe("claude-x");
    expect(info.selectionMode).toBe("strada-hard-pin");
    expect(m.listExecutionCandidates("chat-1").map((c) => c.name)).toEqual(["claude"]);
  });

  it.each(["strada-preference-bias", "strada-hard-pin"] as const)("a %s row stored under a label keeps its model in the pool", (selectionMode) => {
    // setPreference canonicalizes, but a row written before it did is read raw.
    preferenceState.set("chat-1", { providerName: "Anthropic Claude", model: "claude-x", selectionMode });
    const m = claudeManager(["anthropic"]);
    expect(m.listExecutionCandidates("chat-1").map((c) => [c.name, c.defaultModel])).toEqual([["claude", "claude-x"]]);
  });

  it("a chain built for the other spelling holds the seat once and keeps the requested model", () => {
    claudeManager(["anthropic"]).getProviderByName("claude", "claude-x");
    expect(buildProviderChainMock).toHaveBeenLastCalledWith(
      ["claude"],
      expect.anything(),
      expect.objectContaining({ models: expect.objectContaining({ claude: "claude-x" }) }),
    );
    // Unpinned too: the seat is not tried twice under two names.
    claudeManager(["anthropic", "openai"], false).getProviderByName("claude");
    expect(buildProviderChainMock).toHaveBeenLastCalledWith(["claude", "openai"], expect.anything(), expect.anything());
  });
});
