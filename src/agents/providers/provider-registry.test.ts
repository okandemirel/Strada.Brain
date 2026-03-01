import { describe, it, expect, vi } from "vitest";
import { createProvider, buildProviderChain, PROVIDER_PRESETS } from "./provider-registry.js";

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
});

describe("createProvider", () => {
  it("creates Claude provider", () => {
    const provider = createProvider({ name: "claude", apiKey: "sk-test" });
    expect(provider.name).toBe("claude");
  });

  it("creates Ollama provider", () => {
    const provider = createProvider({ name: "ollama" });
    expect(provider.name).toBe("ollama");
  });

  it("creates OpenAI-compatible provider from preset", () => {
    const provider = createProvider({ name: "deepseek", apiKey: "sk-deep" });
    expect(provider.name).toBe("openai");
  });

  it("throws for unknown provider without baseUrl", () => {
    expect(() => createProvider({ name: "unknown", apiKey: "x" })).toThrow(
      'Unknown provider "unknown"'
    );
  });

  it("throws when API key missing for Claude", () => {
    expect(() => createProvider({ name: "claude" })).toThrow("requires an API key");
  });

  it("throws when API key missing for OpenAI-compatible", () => {
    expect(() => createProvider({ name: "openai" })).toThrow("requires an API key");
  });
});

describe("buildProviderChain", () => {
  it("builds single provider", () => {
    const provider = buildProviderChain(["claude"], { claude: "sk-test" });
    expect(provider.name).toBe("claude");
  });

  it("builds fallback chain from multiple providers", () => {
    const provider = buildProviderChain(
      ["claude", "deepseek"],
      { claude: "sk-ant", deepseek: "sk-deep" }
    );
    expect(provider.name).toBe("chain(claude→openai)");
  });

  it("skips providers with missing keys", () => {
    const provider = buildProviderChain(
      ["claude", "openai", "deepseek"],
      { claude: "sk-ant" } // openai and deepseek keys missing
    );
    // Only claude should remain (single provider, no chain)
    expect(provider.name).toBe("claude");
  });

  it("throws when no valid providers", () => {
    expect(() =>
      buildProviderChain(["openai", "deepseek"], {})
    ).toThrow("No valid providers configured");
  });

  it("includes ollama without API key", () => {
    const provider = buildProviderChain(
      ["claude", "ollama"],
      { claude: "sk-ant" }
    );
    expect(provider.name).toBe("chain(claude→ollama)");
  });
});
