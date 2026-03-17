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
      { qwen: "qwen-key", kimi: "kimi-key" },
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
      { qwen: "qwen-key", kimi: "kimi-key" },
      { qwen: "qwen-max", kimi: "kimi-for-coding" },
      "/tmp/provider-manager-test",
      ["qwen", "kimi"],
    );

    expect(manager.getActiveInfo("chat-1")).toEqual({
      providerName: "qwen",
      model: "qwen-max",
      isDefault: true,
    });
  });

  it("wraps a preferred provider with the configured fallback chain", () => {
    const defaultProvider = makeProvider("chain(qwen->kimi)");
    preferenceState.set("chat-1", { providerName: "kimi", model: "kimi-long-context" });
    const manager = new ProviderManager(
      defaultProvider,
      { qwen: "qwen-key", kimi: "kimi-key" },
      { qwen: "qwen-max", kimi: "kimi-for-coding" },
      "/tmp/provider-manager-test",
      ["qwen", "kimi"],
    );

    const provider = manager.getProvider("chat-1");

    expect(buildProviderChainMock).toHaveBeenCalledWith(
      ["kimi", "qwen"],
      { qwen: "qwen-key", kimi: "kimi-key" },
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
      { qwen: "qwen-key", kimi: "kimi-key" },
      { qwen: "qwen-max", kimi: "kimi-for-coding" },
      "/tmp/provider-manager-test",
      ["qwen", "kimi"],
    );

    const provider = manager.getProviderByName("kimi");

    expect(buildProviderChainMock).toHaveBeenCalledWith(
      ["kimi", "qwen"],
      { qwen: "qwen-key", kimi: "kimi-key" },
      {
        models: {
          qwen: "qwen-max",
          kimi: "kimi-for-coding",
        },
      },
    );
    expect(provider?.name).toBe("chain(kimi->qwen)");
  });

  it("falls back to the default provider when resilient chain creation fails", () => {
    const defaultProvider = makeProvider("chain(qwen->kimi)");
    preferenceState.set("chat-1", { providerName: "kimi" });
    buildProviderChainMock.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    const manager = new ProviderManager(
      defaultProvider,
      { qwen: "qwen-key", kimi: "kimi-key" },
      { qwen: "qwen-max", kimi: "kimi-for-coding" },
      "/tmp/provider-manager-test",
      ["qwen", "kimi"],
    );

    expect(manager.getProvider("chat-1")).toBe(defaultProvider);
  });
});
