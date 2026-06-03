import { describe, it, expect, vi } from "vitest";
import { createProvider, buildProviderChain, PROVIDER_PRESETS } from "./provider-registry.js";
import { GeminiProvider } from "./gemini.js";
import { DeepSeekProvider } from "./deepseek.js";
import { QwenProvider } from "./qwen.js";
import { KimiProvider } from "./kimi.js";
import { MiniMaxProvider } from "./minimax.js";
import { GroqProvider } from "./groq.js";
import { MistralProvider } from "./mistral.js";
import { TogetherProvider } from "./together.js";
import { FireworksProvider } from "./fireworks.js";
import { OpencodeProvider } from "./opencode.js";
import { OpenAIProvider } from "./openai.js";

/**
 * Read the protected `model` / `baseUrl` fields off an OpenAI-compatible
 * provider for assertions. These are `protected readonly` on OpenAIProvider,
 * so tests reach them via a typed cast (same pattern opencode.test.ts uses for
 * `buildHeaders`).
 */
function readProviderInternals(provider: unknown): { model: string; baseUrl: string } {
  return provider as { model: string; baseUrl: string };
}

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("PROVIDER_PRESETS", () => {
  it("includes all major providers", () => {
    expect(PROVIDER_PRESETS["openai"]).toBeDefined();
    expect(PROVIDER_PRESETS["deepseek"]).toBeDefined();
    expect(PROVIDER_PRESETS["qwen"]).toBeDefined();
    expect(PROVIDER_PRESETS["kimi"]).toBeDefined();
    expect(PROVIDER_PRESETS["minimax"]).toBeDefined();
    expect(PROVIDER_PRESETS["groq"]).toBeDefined();
    expect(PROVIDER_PRESETS["mistral"]).toBeDefined();
    expect(PROVIDER_PRESETS["together"]).toBeDefined();
    expect(PROVIDER_PRESETS["fireworks"]).toBeDefined();
    expect(PROVIDER_PRESETS["gemini"]).toBeDefined();
  });

  it("each preset has baseUrl, defaultModel, and label", () => {
    for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
      expect(preset.baseUrl, `${name} missing baseUrl`).toBeTruthy();
      expect(preset.defaultModel, `${name} missing defaultModel`).toBeTruthy();
      expect(preset.label, `${name} missing label`).toBeTruthy();
    }
  });

  it("tracks the current MiniMax default worker model", () => {
    expect(PROVIDER_PRESETS["minimax"]?.defaultModel).toBe("MiniMax-M2.7");
  });
});

describe("createProvider", () => {
  it("creates Claude provider", () => {
    const provider = createProvider({ name: "claude", apiKey: "sk-test" });
    expect(provider.name).toBe("claude");
  });

  it("creates Claude provider from a subscription auth token", () => {
    const provider = createProvider({
      name: "claude",
      anthropicAuthMode: "claude-subscription",
      anthropicAuthToken: "claude-subscription-token-123456",
    });
    expect(provider.name).toBe("claude");
  });

  it("ignores a stale Claude auth token unless subscription mode is selected", () => {
    expect(() => createProvider({
      name: "claude",
      anthropicAuthMode: "api-key",
      anthropicAuthToken: "stale-claude-subscription-token-123456",
    })).toThrow("Claude provider requires an API key or Claude subscription auth token");
  });

  it("creates Ollama provider", () => {
    const provider = createProvider({ name: "ollama" });
    expect(provider.name).toBe("ollama");
  });

  it("creates OpenAI-compatible provider from preset with correct label", () => {
    const provider = createProvider({ name: "deepseek", apiKey: "sk-deep" });
    expect(provider.name).toBe("DeepSeek");
  });

  it("uses preset label for Kimi provider", () => {
    const provider = createProvider({ name: "kimi", apiKey: "sk-kimi" });
    expect(provider.name).toBe("Kimi (Moonshot)");
  });

  it("throws for unknown provider without baseUrl", () => {
    expect(() => createProvider({ name: "unknown", apiKey: "x" })).toThrow(
      'Unknown provider "unknown"',
    );
  });

  it("throws when API key missing for Claude", () => {
    expect(() => createProvider({ name: "claude" })).toThrow("requires an API key");
  });

  it("throws when API key missing for OpenAI-compatible", () => {
    expect(() => createProvider({ name: "openai" })).toThrow("requires an API key");
  });

  it("accepts OpenAI ChatGPT/Codex subscription auth without an API key", () => {
    const provider = createProvider({
      name: "openai",
      openaiAuthMode: "chatgpt-subscription",
      openaiChatgptAuthFile: "~/.codex/auth.json",
    });

    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.name).toBe("OpenAI");
  });

  it("uses correct label for OpenAI provider", () => {
    const provider = createProvider({ name: "openai", apiKey: "sk-test" });
    expect(provider.name).toBe("OpenAI");
  });

  it("returns correct class instances for each provider", () => {
    const cases: Array<[string, new (...args: unknown[]) => unknown]> = [
      ["openai", OpenAIProvider],
      ["gemini", GeminiProvider],
      ["deepseek", DeepSeekProvider],
      ["qwen", QwenProvider],
      ["kimi", KimiProvider],
      ["minimax", MiniMaxProvider],
      ["groq", GroqProvider],
      ["mistral", MistralProvider],
      ["together", TogetherProvider],
      ["fireworks", FireworksProvider],
    ];

    for (const [name, ExpectedClass] of cases) {
      const provider = createProvider({ name, apiKey: "sk-test" });
      expect(provider, `${name} should be instance of ${ExpectedClass.name}`).toBeInstanceOf(ExpectedClass);
    }
  });

  describe("model + baseUrl overrides reach the constructed provider", () => {
    it("flows an opencode model override through to the provider .model (not the hardcoded default)", () => {
      const provider = createProvider({
        name: "opencode",
        apiKey: "sk-opencode",
        model: "opencode/grok-code",
      });
      expect(provider).toBeInstanceOf(OpencodeProvider);
      const { model } = readProviderInternals(provider);
      expect(model).toBe("opencode/grok-code");
      expect(model).not.toBe("opencode/qwen-3-coder-480b");
    });

    it("defaults opencode .baseUrl to Zen when no override is supplied", () => {
      const provider = createProvider({ name: "opencode", apiKey: "sk-opencode" });
      const { baseUrl } = readProviderInternals(provider);
      expect(baseUrl).toBe("https://opencode.ai/zen/v1");
    });

    it("flows an OPENCODE_BASE_URL override through to the provider .baseUrl", () => {
      const provider = createProvider({
        name: "opencode",
        apiKey: "sk-opencode",
        baseUrl: "https://opencode.ai/go/v1",
      });
      const { baseUrl } = readProviderInternals(provider);
      expect(baseUrl).toBe("https://opencode.ai/go/v1");
    });

    it.each([
      ["deepseek", "deepseek-v4-pro"],
      ["kimi", "kimi-k2.6"],
      ["qwen", "qwen-3.6-plus"],
      ["minimax", "MiniMax-M2.5"],
      ["together", "meta-llama/Llama-4-Scout-17B-16E-Instruct"],
    ])("flows a model override for %s through to the provider .model", (name, model) => {
      const provider = createProvider({ name, apiKey: "sk-test", model });
      const { model: actual } = readProviderInternals(provider);
      expect(actual).toBe(model);
      // Sanity: the override must differ from the preset default it replaces.
      expect(actual).not.toBe(PROVIDER_PRESETS[name]!.defaultModel);
    });
  });
});

describe("buildProviderChain", () => {
  it("builds single provider", () => {
    const provider = buildProviderChain(["claude"], { claude: { apiKey: "sk-test" } });
    expect(provider.name).toBe("chain(claude)");
  });

  it("builds fallback chain from multiple providers", () => {
    const provider = buildProviderChain(["claude", "deepseek"], {
      claude: { apiKey: "sk-ant" },
      deepseek: { apiKey: "sk-deep" },
    });
    expect(provider.name).toBe("chain(claude→DeepSeek)");
  });

  it("skips providers with missing keys", () => {
    const provider = buildProviderChain(
      ["claude", "openai", "deepseek"],
      { claude: { apiKey: "sk-ant" } }, // openai and deepseek keys missing
    );
    // Only claude should remain (wrapped in chain for health tracking)
    expect(provider.name).toBe("chain(claude)");
  });

  it("throws when no valid providers", () => {
    expect(() => buildProviderChain(["openai", "deepseek"], {})).toThrow(
      "No valid providers configured",
    );
  });

  it("includes ollama without API key", () => {
    const provider = buildProviderChain(["claude", "ollama"], { claude: { apiKey: "sk-ant" } });
    expect(provider.name).toBe("chain(claude→ollama)");
  });

  it("builds OpenAI from ChatGPT/Codex subscription credentials", () => {
    const provider = buildProviderChain(["openai"], {
      openai: {
        openaiAuthMode: "chatgpt-subscription",
        openaiChatgptAuthFile: "~/.codex/auth.json",
      },
    });

    expect(provider.name).toBe("chain(OpenAI)");
  });

  it("builds Claude from subscription token credentials", () => {
    const provider = buildProviderChain(["claude"], {
      claude: {
        anthropicAuthMode: "claude-subscription",
        anthropicAuthToken: "claude-subscription-token-123456",
      },
    });

    expect(provider.name).toBe("chain(claude)");
  });

  it("threads opencode model + baseUrl overrides through to the chained provider", () => {
    const chain = buildProviderChain(
      ["opencode"],
      { opencode: { apiKey: "sk-opencode" } },
      {
        models: { opencode: "opencode/grok-code" },
        baseUrls: { opencode: "https://opencode.ai/go/v1" },
      },
    );
    const inner = (chain as unknown as { providers: unknown[] }).providers[0];
    expect(inner).toBeInstanceOf(OpencodeProvider);
    const { model, baseUrl } = readProviderInternals(inner);
    expect(model).toBe("opencode/grok-code");
    expect(baseUrl).toBe("https://opencode.ai/go/v1");
  });
});
