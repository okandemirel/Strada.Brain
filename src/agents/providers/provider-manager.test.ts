import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAIProvider } from "./provider.interface.js";

const { preferenceState, buildProviderChainMock } = vi.hoisted(() => ({
  preferenceState: new Map<string, { providerName: string; model?: string }>(),
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
      vision: false,
      systemPrompt: true,
    },
    chat: vi.fn().mockResolvedValue({
      text: `${name} ok`,
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }),
  };
}

vi.mock("./provider-registry.js", () => ({
  PROVIDER_PRESETS: {
    qwen: {
      baseUrl: "https://example.test/qwen",
      defaultModel: "qwen-max",
      label: "Qwen (Alibaba)",
    },
    kimi: {
      baseUrl: "https://example.test/kimi",
      defaultModel: "kimi-for-coding",
      label: "Kimi (Moonshot)",
    },
  },
  buildProviderChain: buildProviderChainMock,
  createProvider: vi.fn(({ name }: { name: string }) => makeProvider(name)),
}));

vi.mock("./provider-preferences.js", () => ({
  ProviderPreferenceStore: vi.fn().mockImplementation(() => ({
    initialize: vi.fn(),
    get: vi.fn((chatId: string) => preferenceState.get(chatId)),
    set: vi.fn((chatId: string, providerName: string, model?: string) => {
      preferenceState.set(chatId, { providerName, model });
    }),
    delete: vi.fn((chatId: string) => {
      preferenceState.delete(chatId);
    }),
    close: vi.fn(),
  })),
}));

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { ProviderManager } from "./provider-manager.js";

describe("ProviderManager", () => {
  beforeEach(() => {
    preferenceState.clear();
    buildProviderChainMock.mockReset();
    buildProviderChainMock.mockImplementation((order: string[]) => makeProvider(`chain(${order.join("->")})`));
  });

  it("returns the default provider when no chat preference exists", () => {
    const defaultProvider = makeProvider("chain(qwen->kimi)");
    const manager = new ProviderManager(
      defaultProvider,
      { qwen: { apiKey: "qwen-key" }, kimi: { apiKey: "kimi-key" } },
      { qwen: "qwen-max", kimi: "kimi-for-coding" },
      "/tmp/provider-manager-test",
      ["qwen", "kimi"],
    );

    expect(manager.getProvider("chat-1")).toBe(defaultProvider);
    expect(buildProviderChainMock).not.toHaveBeenCalled();
  });

  it("reports canonical default provider info instead of fallback chain name", () => {
    const defaultProvider = makeProvider("chain(qwen->kimi)");
    const manager = new ProviderManager(
      defaultProvider,
      { qwen: { apiKey: "qwen-key" }, kimi: { apiKey: "kimi-key" } },
      { qwen: "qwen-max", kimi: "kimi-for-coding" },
      "/tmp/provider-manager-test",
      ["qwen", "kimi"],
    );

    expect(manager.getActiveInfo("chat-1")).toEqual({
      providerName: "qwen",
      model: "qwen-max",
      isDefault: true,
      selectionMode: "strada-primary-worker",
      executionPolicyNote: "Strada remains the control plane. This selection sets the primary execution worker; planning, review, and synthesis may still route to other providers.",
    });
  });

  it("wraps a preferred provider with the configured fallback chain", () => {
    const defaultProvider = makeProvider("chain(qwen->kimi)");
    preferenceState.set("chat-1", { providerName: "kimi", model: "kimi-long-context" });
    const manager = new ProviderManager(
      defaultProvider,
      { qwen: { apiKey: "qwen-key" }, kimi: { apiKey: "kimi-key" } },
      { qwen: "qwen-max", kimi: "kimi-for-coding" },
      "/tmp/provider-manager-test",
      ["qwen", "kimi"],
    );

    const provider = manager.getProvider("chat-1");

    expect(buildProviderChainMock).toHaveBeenCalledWith(
      ["kimi", "qwen"],
      { qwen: { apiKey: "qwen-key" }, kimi: { apiKey: "kimi-key" } },
      {
        models: {
          qwen: "qwen-max",
          kimi: "kimi-long-context",
        },
      },
    );
    expect(provider.name).toBe("chain(kimi->qwen)");
  });

  it("returns a resilient routed provider with fallbacks behind it", () => {
    const defaultProvider = makeProvider("chain(qwen->kimi)");
    const manager = new ProviderManager(
      defaultProvider,
      { qwen: { apiKey: "qwen-key" }, kimi: { apiKey: "kimi-key" } },
      { qwen: "qwen-max", kimi: "kimi-for-coding" },
      "/tmp/provider-manager-test",
      ["qwen", "kimi"],
    );

    const provider = manager.getProviderByName("kimi");

    expect(buildProviderChainMock).toHaveBeenCalledWith(
      ["kimi", "qwen"],
      { qwen: { apiKey: "qwen-key" }, kimi: { apiKey: "kimi-key" } },
      {
        models: {
          qwen: "qwen-max",
          kimi: "kimi-for-coding",
        },
      },
    );
    expect(provider?.name).toBe("chain(kimi->qwen)");
  });

  it("limits execution candidates to the configured default chain", () => {
    const defaultProvider = makeProvider("chain(qwen->kimi)");
    const manager = new ProviderManager(
      defaultProvider,
      {
        qwen: { apiKey: "qwen-key" },
        kimi: { apiKey: "kimi-key" },
        openai: { apiKey: "openai-key" },
      },
      { qwen: "qwen-max", kimi: "kimi-for-coding", openai: "gpt-5.2" },
      "/tmp/provider-manager-test",
      ["qwen", "kimi"],
    );

    expect(manager.listExecutionCandidates().map((entry) => entry.name)).toEqual(["qwen", "kimi"]);
  });

  it("prepends the active worker to the execution pool when selected outside the default chain", () => {
    const defaultProvider = makeProvider("chain(qwen->kimi)");
    preferenceState.set("chat-1", { providerName: "openai", model: "gpt-5.2" });
    const manager = new ProviderManager(
      defaultProvider,
      {
        qwen: { apiKey: "qwen-key" },
        kimi: { apiKey: "kimi-key" },
        openai: { apiKey: "openai-key" },
      },
      { qwen: "qwen-max", kimi: "kimi-for-coding", openai: "gpt-5.2" },
      "/tmp/provider-manager-test",
      ["qwen", "kimi"],
    );

    expect(manager.listExecutionCandidates("chat-1").map((entry) => `${entry.name}:${entry.defaultModel}`)).toEqual([
      "openai:gpt-5.2",
      "qwen:qwen-max",
      "kimi:kimi-for-coding",
    ]);
  });

  it("falls back to the default provider when resilient chain creation fails", () => {
    const defaultProvider = makeProvider("chain(qwen->kimi)");
    preferenceState.set("chat-1", { providerName: "kimi" });
    buildProviderChainMock.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    const manager = new ProviderManager(
      defaultProvider,
      { qwen: { apiKey: "qwen-key" }, kimi: { apiKey: "kimi-key" } },
      { qwen: "qwen-max", kimi: "kimi-for-coding" },
      "/tmp/provider-manager-test",
      ["qwen", "kimi"],
    );

    expect(manager.getProvider("chat-1")).toBe(defaultProvider);
  });

  it("merges official source features into provider capabilities", () => {
    const defaultProvider = makeProvider("chain(qwen->kimi)");
    const manager = new ProviderManager(
      defaultProvider,
      { qwen: { apiKey: "qwen-key" }, kimi: { apiKey: "kimi-key" } },
      { qwen: "qwen-max", kimi: "kimi-for-coding" },
      "/tmp/provider-manager-test",
      ["qwen", "kimi"],
    );

    manager.setModelCatalog({
      getProviderModels: () => [],
      getProviderOfficialSnapshot: () => ({
        provider: "kimi",
        lastUpdated: Date.now(),
        sourceUrls: ["https://official.example/kimi"],
        signals: [],
        featureTags: ["agents", "planning"],
      }),
    });

    const capabilities = manager.getProviderCapabilities("kimi", "kimi-for-coding");

    expect(capabilities?.specialFeatures).toEqual(expect.arrayContaining(["agents", "planning"]));
  });
});
