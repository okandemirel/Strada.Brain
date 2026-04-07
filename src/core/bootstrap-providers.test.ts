import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config } from "../config/config.js";
import type * as winston from "winston";

// ---------------------------------------------------------------------------
// Mocks — declared before imports
// ---------------------------------------------------------------------------

vi.mock("../agents/providers/claude.js", () => ({
  ClaudeProvider: vi.fn().mockImplementation(function (keyOrConfig: unknown) {
    return {
      name: "claude",
      _key: keyOrConfig,
      healthCheck: vi.fn().mockResolvedValue(true),
    };
  }),
}));

const mockBuildProviderChain = vi.fn();
vi.mock("../agents/providers/provider-registry.js", () => ({
  buildProviderChain: (...args: unknown[]) => mockBuildProviderChain(...args),
}));

const mockProviderManagerInstance = {
  setOllamaVerified: vi.fn(),
  _tag: "provider-manager",
};
vi.mock("../agents/providers/provider-manager.js", () => ({
  ProviderManager: vi.fn().mockImplementation(function () { return mockProviderManagerInstance; }),
}));

vi.mock("../rag/embeddings/embedding-cache.js", () => ({
  CachedEmbeddingProvider: vi.fn().mockImplementation(function (provider: unknown, opts: unknown) {
    return {
      _tag: "cached-embedding",
      _provider: provider,
      _opts: opts,
      initialize: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

const mockResolveEmbeddingProvider = vi.fn();
const mockCollectApiKeys = vi.fn();
const mockDescribeEmbeddingResolutionFailure = vi.fn();
vi.mock("../rag/embeddings/embedding-resolver.js", () => ({
  resolveEmbeddingProvider: (...args: unknown[]) => mockResolveEmbeddingProvider(...args),
  collectApiKeys: (...args: unknown[]) => mockCollectApiKeys(...args),
  describeEmbeddingResolutionFailure: (...args: unknown[]) =>
    mockDescribeEmbeddingResolutionFailure(...args),
}));

const mockCollectProviderCredentials = vi.fn();
const mockHasConfiguredAnthropicSubscription = vi.fn();
const mockHasConfiguredOpenAISubscription = vi.fn();
const mockNormalizeProviderNames = vi.fn();
const mockHasUsableProviderConfig = vi.fn();
vi.mock("./provider-config.js", () => ({
  collectProviderCredentials: (...args: unknown[]) => mockCollectProviderCredentials(...args),
  hasConfiguredAnthropicSubscription: (...args: unknown[]) =>
    mockHasConfiguredAnthropicSubscription(...args),
  hasConfiguredOpenAISubscription: (...args: unknown[]) =>
    mockHasConfiguredOpenAISubscription(...args),
  normalizeProviderNames: (...args: unknown[]) => mockNormalizeProviderNames(...args),
  hasUsableProviderConfig: (...args: unknown[]) => mockHasUsableProviderConfig(...args),
}));

const mockPreflightResponseProviders = vi.fn();
const mockFormatProviderPreflightFailures = vi.fn();
vi.mock("./response-provider-preflight.js", () => ({
  preflightResponseProviders: (...args: unknown[]) => mockPreflightResponseProviders(...args),
  formatProviderPreflightFailures: (...args: unknown[]) =>
    mockFormatProviderPreflightFailures(...args),
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import {
  initializeAIProvider,
  isTransientEmbeddingVerificationError,
  describeEmbeddingConsumers,
  resolveAndCacheEmbeddings,
} from "./bootstrap-providers.js";
import { AppError } from "../common/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLogger(): winston.Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as winston.Logger;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    anthropicApiKey: undefined,
    anthropicAuthToken: undefined,
    openaiApiKey: undefined,
    providerChain: undefined,
    providerModels: {},
    memory: { dbPath: "/tmp/test-memory" } as Config["memory"],
    rag: {
      enabled: false,
      provider: "auto",
      contextMaxTokens: 4000,
    } as Config["rag"],
    ...overrides,
  } as Config;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bootstrap-providers", () => {
  let logger: winston.Logger;

  beforeEach(() => {
    logger = createMockLogger();
    vi.clearAllMocks();

    // Sensible defaults for mocks
    mockCollectApiKeys.mockReturnValue({});
    mockCollectProviderCredentials.mockReturnValue({});
    mockHasConfiguredAnthropicSubscription.mockReturnValue(false);
    mockHasConfiguredOpenAISubscription.mockReturnValue(false);
    mockNormalizeProviderNames.mockImplementation((chain: string) => chain.split(","));
    mockHasUsableProviderConfig.mockReturnValue(true);
    mockBuildProviderChain.mockReturnValue({
      name: "chain-provider",
      healthCheck: vi.fn().mockResolvedValue(true),
    });
    mockPreflightResponseProviders.mockResolvedValue({
      passedProviderIds: [],
      failures: [],
    });
    mockFormatProviderPreflightFailures.mockReturnValue("formatted failures");

    // Prevent real fetch for Ollama check
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("not reachable"));
  });

  // ========================================================================
  // initializeAIProvider — explicit provider chain
  // ========================================================================

  describe("initializeAIProvider — explicit chain", () => {
    it("builds a provider chain from configured providerChain", async () => {
      const config = makeConfig({ providerChain: "gemini,deepseek" });
      mockNormalizeProviderNames.mockReturnValue(["gemini", "deepseek"]);
      mockHasUsableProviderConfig.mockReturnValue(true);
      mockPreflightResponseProviders.mockResolvedValue({
        passedProviderIds: ["gemini", "deepseek"],
        failures: [],
      });

      const result = await initializeAIProvider(config, logger);

      expect(mockBuildProviderChain).toHaveBeenCalledWith(
        expect.arrayContaining(["gemini", "deepseek"]),
        expect.any(Object),
        expect.any(Object),
      );
      expect(result.manager).toBe(mockProviderManagerInstance);
      expect(result.notices).toBeDefined();
    });

    it("throws NO_AI_PROVIDER when configured providers lack credentials", async () => {
      const config = makeConfig({ providerChain: "gemini" });
      mockNormalizeProviderNames.mockReturnValue(["gemini"]);
      mockHasUsableProviderConfig.mockReturnValue(false);

      await expect(initializeAIProvider(config, logger)).rejects.toThrow(AppError);
      await expect(initializeAIProvider(config, logger)).rejects.toThrow(
        /missing usable credentials/,
      );
    });

    it("throws NO_HEALTHY_AI_PROVIDER when preflight fails for chain providers", async () => {
      const config = makeConfig({ providerChain: "gemini" });
      mockNormalizeProviderNames.mockReturnValue(["gemini"]);
      mockHasUsableProviderConfig.mockReturnValue(true);
      mockPreflightResponseProviders.mockResolvedValue({
        passedProviderIds: [],
        failures: [{ providerId: "gemini", error: "timeout" }],
      });

      await expect(initializeAIProvider(config, logger)).rejects.toThrow(AppError);
    });
  });

  // ========================================================================
  // initializeAIProvider — Anthropic key fallback
  // ========================================================================

  describe("initializeAIProvider — Anthropic direct", () => {
    it("uses ClaudeProvider when anthropicApiKey is set and no chain", async () => {
      const config = makeConfig({ anthropicApiKey: "sk-ant-123" });

      const result = await initializeAIProvider(config, logger);

      expect(result.manager).toBe(mockProviderManagerInstance);
      expect(logger.info).toHaveBeenCalledWith(
        "AI provider initialized",
        expect.objectContaining({ name: "claude" }),
      );
    });

    it("uses ClaudeProvider subscription mode when configured", async () => {
      const config = makeConfig({ anthropicAuthToken: "auth-tok" });
      mockHasConfiguredAnthropicSubscription.mockReturnValue(true);

      const result = await initializeAIProvider(config, logger);
      expect(result.manager).toBe(mockProviderManagerInstance);
    });
  });

  // ========================================================================
  // initializeAIProvider — auto-detect
  // ========================================================================

  describe("initializeAIProvider — auto-detect", () => {
    it("auto-detects providers from available API keys", async () => {
      const config = makeConfig();
      mockCollectApiKeys.mockReturnValue({ gemini: "gem-key" });
      mockPreflightResponseProviders.mockResolvedValue({
        passedProviderIds: ["gemini"],
        failures: [],
      });

      const result = await initializeAIProvider(config, logger);

      expect(result.manager).toBe(mockProviderManagerInstance);
      expect(logger.info).toHaveBeenCalledWith(
        "AI provider auto-detected from available keys",
        expect.any(Object),
      );
    });

    it("throws NO_AI_PROVIDER when no keys are available", async () => {
      const config = makeConfig();
      mockCollectApiKeys.mockReturnValue({});

      await expect(initializeAIProvider(config, logger)).rejects.toThrow(AppError);
      await expect(initializeAIProvider(config, logger)).rejects.toThrow(
        /No AI provider configured/,
      );
    });

    it("throws NO_HEALTHY_AI_PROVIDER when all auto-detected providers fail preflight", async () => {
      const config = makeConfig();
      mockCollectApiKeys.mockReturnValue({ deepseek: "dk-key" });
      mockPreflightResponseProviders.mockResolvedValue({
        passedProviderIds: [],
        failures: [{ providerId: "deepseek", error: "unreachable" }],
      });

      await expect(initializeAIProvider(config, logger)).rejects.toThrow(AppError);
    });
  });

  // ========================================================================
  // initializeAIProvider — health check
  // ========================================================================

  describe("initializeAIProvider — health check", () => {
    it("runs health check and logs success", async () => {
      const config = makeConfig({ anthropicApiKey: "sk-ant-123" });

      const result = await initializeAIProvider(config, logger);
      expect(result.healthCheckPassed).toBe(true);
      expect(logger.info).toHaveBeenCalledWith(
        "AI provider health check passed",
        expect.any(Object),
      );
    });
  });

  // ========================================================================
  // initializeAIProvider — Ollama verification
  // ========================================================================

  describe("initializeAIProvider — Ollama reachability", () => {
    it("marks Ollama verified when reachable", async () => {
      const config = makeConfig({ anthropicApiKey: "sk-ant-123" });
      vi.mocked(globalThis.fetch).mockResolvedValueOnce({
        ok: true,
      } as Response);

      await initializeAIProvider(config, logger);
      expect(mockProviderManagerInstance.setOllamaVerified).toHaveBeenCalledWith(true);
    });

    it("does not mark Ollama verified when unreachable", async () => {
      const config = makeConfig({ anthropicApiKey: "sk-ant-123" });
      vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("connection refused"));

      await initializeAIProvider(config, logger);
      expect(mockProviderManagerInstance.setOllamaVerified).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // isTransientEmbeddingVerificationError
  // ========================================================================

  describe("isTransientEmbeddingVerificationError", () => {
    it.each([
      "fetch failed",
      "network error",
      "request timed out",
      "timeout exceeded",
      "aborted",
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ETIMEDOUT",
      "API error 429",
      "API error 500",
      "API error 502",
      "API error 503",
      "API error 504",
    ])("returns true for transient error: %s", (message) => {
      expect(isTransientEmbeddingVerificationError(new Error(message))).toBe(true);
    });

    it("returns false for non-transient errors", () => {
      expect(isTransientEmbeddingVerificationError(new Error("invalid_api_key"))).toBe(false);
      expect(isTransientEmbeddingVerificationError(new Error("API error 401"))).toBe(false);
      expect(isTransientEmbeddingVerificationError(new Error("permission denied"))).toBe(false);
    });

    it("handles non-Error values", () => {
      expect(isTransientEmbeddingVerificationError("fetch failed")).toBe(true);
      expect(isTransientEmbeddingVerificationError("unknown error")).toBe(false);
      expect(isTransientEmbeddingVerificationError(42)).toBe(false);
    });
  });

  // ========================================================================
  // describeEmbeddingConsumers
  // ========================================================================

  describe("describeEmbeddingConsumers", () => {
    it("returns RAG when rag is enabled", () => {
      const config = makeConfig({ rag: { enabled: true } as Config["rag"] });
      expect(describeEmbeddingConsumers(config)).toContain("RAG");
    });

    it("returns memory/learning when memory is enabled", () => {
      const config = makeConfig({
        memory: { enabled: true } as Config["memory"],
      });
      expect(describeEmbeddingConsumers(config)).toContain("memory/learning");
    });

    it("returns both when both are enabled", () => {
      const config = makeConfig({
        rag: { enabled: true } as Config["rag"],
        memory: { enabled: true } as Config["memory"],
      });
      const consumers = describeEmbeddingConsumers(config);
      expect(consumers).toEqual(["RAG", "memory/learning"]);
    });

    it("returns empty array when both are disabled", () => {
      const config = makeConfig({
        rag: { enabled: false } as Config["rag"],
        memory: { enabled: false } as Config["memory"],
      });
      expect(describeEmbeddingConsumers(config)).toEqual([]);
    });
  });

  // ========================================================================
  // resolveAndCacheEmbeddings
  // ========================================================================

  describe("resolveAndCacheEmbeddings", () => {
    it("returns disabled status when no consumers need embeddings", async () => {
      const config = makeConfig({
        rag: { enabled: false, provider: "auto", contextMaxTokens: 4000 } as Config["rag"],
        memory: { enabled: false } as Config["memory"],
      });

      const result = await resolveAndCacheEmbeddings(config, logger);
      expect(result.status.state).toBe("disabled");
      expect(result.status.usingHashFallback).toBe(true);
      expect(result.cachedProvider).toBeUndefined();
    });

    it("returns degraded status when no embedding provider is resolved", async () => {
      const config = makeConfig({
        rag: { enabled: true, provider: "auto", contextMaxTokens: 4000 } as Config["rag"],
        memory: { enabled: false } as Config["memory"],
      });
      mockResolveEmbeddingProvider.mockReturnValue(undefined);
      mockDescribeEmbeddingResolutionFailure.mockReturnValue("no provider found");

      const result = await resolveAndCacheEmbeddings(config, logger);
      expect(result.status.state).toBe("degraded");
      expect(result.notice).toBe("no provider found");
      expect(result.cachedProvider).toBeUndefined();
    });

    it("returns active status with cached provider on success", async () => {
      const config = makeConfig({
        rag: { enabled: true, provider: "openai", contextMaxTokens: 4000 } as Config["rag"],
        memory: { enabled: false, dbPath: "/tmp/test" } as Config["memory"],
      });
      mockResolveEmbeddingProvider.mockReturnValue({
        provider: { name: "openai", dimensions: 1536 },
        source: "config",
      });

      const result = await resolveAndCacheEmbeddings(config, logger);
      expect(result.status.state).toBe("active");
      expect(result.status.usingHashFallback).toBe(false);
      expect(result.cachedProvider).toBeDefined();
    });

    it("returns degraded status when resolution throws", async () => {
      const config = makeConfig({
        memory: { enabled: true } as Config["memory"],
      });
      mockResolveEmbeddingProvider.mockImplementation(() => {
        throw new Error("init failed");
      });

      const result = await resolveAndCacheEmbeddings(config, logger);
      expect(result.status.state).toBe("degraded");
      expect(result.notice).toContain("initialization failed");
    });
  });
});
