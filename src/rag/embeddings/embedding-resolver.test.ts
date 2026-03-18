import { describe, it, expect } from "vitest";
import { resolveEmbeddingProvider } from "./embedding-resolver.js";
import { OpenAIEmbeddingProvider } from "./openai-embeddings.js";
import { OllamaEmbeddingProvider } from "./ollama-embeddings.js";
import type { Config } from "../../config/config.js";

/** Minimal config factory for testing */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    anthropicApiKey: undefined,
    openaiApiKey: undefined,
    deepseekApiKey: undefined,
    qwenApiKey: undefined,
    kimiApiKey: undefined,
    minimaxApiKey: undefined,
    groqApiKey: undefined,
    mistralApiKey: undefined,
    togetherApiKey: undefined,
    fireworksApiKey: undefined,
    geminiApiKey: undefined,
    providerChain: undefined,
    telegram: { allowedUserIds: [] },
    discord: {},
    slack: { socketMode: true },
    security: { requireEditConfirmation: true, readOnlyMode: false },
    unityProjectPath: "/tmp/test",
    dashboard: { enabled: false, port: 3100 },
    websocketDashboard: { enabled: false, port: 3101 },
    prometheus: { enabled: false, port: 9090 },
    memory: { enabled: true, dbPath: ".strada-memory" },
    rag: { enabled: true, provider: "auto", contextMaxTokens: 4000 },
    streamingEnabled: true,
    shellEnabled: true,
    rateLimit: {
      enabled: false,
      messagesPerMinute: 0,
      messagesPerHour: 0,
      tokensPerDay: 0,
      dailyBudgetUsd: 0,
      monthlyBudgetUsd: 0,
    },
    web: { port: 3000 },
    logLevel: "info",
    logFile: "test.log",
    pluginDirs: [],
    ...overrides,
  } as Config;
}

describe("resolveEmbeddingProvider", () => {
  it("auto mode: selects first embedding-capable provider from chain", () => {
    const config = makeConfig({
      providerChain: "kimi,deepseek,openai",
      kimiApiKey: "kimi-key",
      deepseekApiKey: "ds-key",
      openaiApiKey: "oai-key",
    });

    const result = resolveEmbeddingProvider(config);
    expect(result).not.toBeNull();
    // DeepSeek no longer supports embeddings, so OpenAI should be selected
    expect(result!.source).toBe("auto:openai");
    expect(result!.provider).toBeInstanceOf(OpenAIEmbeddingProvider);
    expect(result!.provider.name).toContain("OpenAI");
  });

  it("auto mode: returns null when chain has only unsupported providers and no fallback key", () => {
    const config = makeConfig({
      providerChain: "kimi,groq,minimax",
      kimiApiKey: "kimi-key",
      groqApiKey: "groq-key",
      minimaxApiKey: "mm-key",
    });

    const result = resolveEmbeddingProvider(config);
    expect(result).toBeNull();
  });

  it("auto mode: falls back to configured embedding provider outside the response chain", () => {
    const config = makeConfig({
      providerChain: "kimi",
      kimiApiKey: "kimi-key",
      geminiApiKey: "gem-key",
    });

    const result = resolveEmbeddingProvider(config);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("auto-fallback:gemini");
    expect(result!.provider.name).toContain("Gemini");
    expect(result!.provider.dimensions).toBe(3072);
  });

  it("explicit mode: openai returns OpenAIEmbeddingProvider", () => {
    const config = makeConfig({
      openaiApiKey: "oai-key",
      rag: { enabled: true, provider: "openai", contextMaxTokens: 4000 },
    });

    const result = resolveEmbeddingProvider(config);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("explicit:openai");
    expect(result!.provider).toBeInstanceOf(OpenAIEmbeddingProvider);
  });

  it("explicit mode: ollama returns OllamaEmbeddingProvider", () => {
    const config = makeConfig({
      rag: { enabled: true, provider: "ollama", contextMaxTokens: 4000 },
    });

    const result = resolveEmbeddingProvider(config);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("explicit:ollama");
    expect(result!.provider).toBeInstanceOf(OllamaEmbeddingProvider);
  });

  it("explicit auto mode with kimi-only chain falls back when a supported provider key exists", () => {
    const config = makeConfig({
      kimiApiKey: "kimi-key",
      geminiApiKey: "gem-key",
      rag: { enabled: true, provider: "auto", contextMaxTokens: 4000 },
      providerChain: "kimi",
    });

    const result = resolveEmbeddingProvider(config);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("auto-fallback:gemini");
  });

  it("returns null when API key is missing for explicit provider", () => {
    const config = makeConfig({
      rag: { enabled: true, provider: "openai", contextMaxTokens: 4000 },
      // openaiApiKey intentionally not set
    });

    const result = resolveEmbeddingProvider(config);
    expect(result).toBeNull();
  });

  it("EMBEDDING_MODEL override is applied", () => {
    const config = makeConfig({
      openaiApiKey: "oai-key",
      rag: {
        enabled: true,
        provider: "openai",
        model: "text-embedding-3-large",
        contextMaxTokens: 4000,
      },
    });

    const result = resolveEmbeddingProvider(config);
    expect(result).not.toBeNull();
    expect(result!.provider.name).toContain("text-embedding-3-large");
  });

  it("gemini uses gemini-embedding-2-preview with 3072 dimensions", () => {
    const config = makeConfig({
      geminiApiKey: "gem-key",
      rag: { enabled: true, provider: "gemini", contextMaxTokens: 4000 },
    });

    const result = resolveEmbeddingProvider(config);
    expect(result).not.toBeNull();
    expect(result!.provider.name).toContain("Gemini");
    expect(result!.provider.dimensions).toBe(3072);
  });

  it("gemini respects EMBEDDING_DIMENSIONS override via Matryoshka", () => {
    const config = makeConfig({
      geminiApiKey: "gem-key",
      rag: { enabled: true, provider: "gemini", dimensions: 768, contextMaxTokens: 4000 },
    });

    const result = resolveEmbeddingProvider(config);
    expect(result).not.toBeNull();
    expect(result!.provider.dimensions).toBe(768);
  });

  it("ignores unsupported dimension override", () => {
    const config = makeConfig({
      geminiApiKey: "gem-key",
      rag: { enabled: true, provider: "gemini", dimensions: 999, contextMaxTokens: 4000 },
    });

    const result = resolveEmbeddingProvider(config);
    expect(result).not.toBeNull();
    expect(result!.provider.dimensions).toBe(3072);
  });

  it("auto mode without chain: falls back to any available key", () => {
    const config = makeConfig({
      mistralApiKey: "mistral-key",
    });

    const result = resolveEmbeddingProvider(config);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("auto:mistral");
    expect(result!.provider.name).toContain("Mistral");
  });

  it("auto mode: skips claude in chain (no embedding support)", () => {
    const config = makeConfig({
      providerChain: "claude,openai",
      anthropicApiKey: "ant-key",
      openaiApiKey: "oai-key",
    });

    const result = resolveEmbeddingProvider(config);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("auto:openai");
  });
});
