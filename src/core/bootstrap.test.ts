/**
 * Bootstrap Tests — AgentDB wiring with self-healing initialization
 *
 * Tests the initializeMemory function behavior for:
 * - AgentDB backend (default)
 * - File backend (explicit)
 * - Self-healing on failure (repair + retry + fallback)
 * - Config mapping to AgentDBMemory constructor
 * - Disabled memory
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  resolveEmbeddingProviderMock,
  cachedEmbeddingInitializeMock,
  cachedEmbeddingEmbedMock,
} = vi.hoisted(() => ({
  resolveEmbeddingProviderMock: vi.fn(),
  cachedEmbeddingInitializeMock: vi.fn().mockResolvedValue(undefined),
  cachedEmbeddingEmbedMock: vi.fn().mockResolvedValue({
    embeddings: [[0.1, 0.2, 0.3]],
    dimensions: 3,
  }),
}));

// Mock modules before imports
vi.mock("../memory/unified/agentdb-memory.js", () => {
  const MockAgentDBMemory = vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue({ kind: "ok", value: undefined }),
    shutdown: vi.fn(),
    setDecayConfig: vi.fn(),
  }));
  return { AgentDBMemory: MockAgentDBMemory };
});

vi.mock("../memory/unified/agentdb-adapter.js", () => {
  const MockAgentDBAdapter = vi.fn().mockImplementation((agentdb: unknown) => ({
    _agentdb: agentdb,
    _isAdapter: true,
  }));
  return { AgentDBAdapter: MockAgentDBAdapter };
});

vi.mock("../memory/file-memory-manager.js", () => {
  const MockFileMemoryManager = vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    _isFileManager: true,
  }));
  return { FileMemoryManager: MockFileMemoryManager };
});

vi.mock("better-sqlite3", () => {
  const MockDatabase = vi.fn().mockImplementation(() => ({
    pragma: vi.fn(),
    prepare: vi.fn().mockReturnValue({ get: vi.fn() }),
    close: vi.fn(),
  }));
  return { default: MockDatabase };
});

vi.mock("../memory/unified/migration.js", () => {
  return {
    runAutomaticMigration: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("../agents/providers/provider-registry.js", () => {
  return {
    buildProviderChain: vi.fn().mockImplementation((names: string[]) => ({
      name: names.join(","),
      healthCheck: vi.fn().mockResolvedValue(true),
    })),
  };
});

vi.mock("../agents/providers/provider-manager.js", () => {
  const MockProviderManager = vi.fn().mockImplementation((defaultProvider: unknown) => ({
    defaultProvider,
    getProvider: vi.fn().mockReturnValue(defaultProvider),
    shutdown: vi.fn(),
  }));
  return { ProviderManager: MockProviderManager };
});

vi.mock("../agents/providers/claude.js", () => {
  const MockClaudeProvider = vi.fn().mockImplementation(() => ({
    name: "claude",
    healthCheck: vi.fn().mockResolvedValue(true),
  }));
  return { ClaudeProvider: MockClaudeProvider };
});

vi.mock("../rag/embeddings/embedding-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rag/embeddings/embedding-resolver.js")>();
  return {
    ...actual,
    resolveEmbeddingProvider: resolveEmbeddingProviderMock,
  };
});

vi.mock("../rag/embeddings/embedding-cache.js", () => {
  const MockCachedEmbeddingProvider = vi.fn().mockImplementation((provider: { name: string; dimensions?: number }) => ({
    name: provider.name,
    dimensions: provider.dimensions ?? 3072,
    initialize: cachedEmbeddingInitializeMock,
    embed: cachedEmbeddingEmbedMock,
  }));
  return { CachedEmbeddingProvider: MockCachedEmbeddingProvider };
});

// Import the function under test
import {
  initializeAIProvider,
  initializeMemory,
  isTransientEmbeddingVerificationError,
  resolveAndCacheEmbeddings,
} from "./bootstrap.js";
import { AgentDBMemory } from "../memory/unified/agentdb-memory.js";
import { AgentDBAdapter } from "../memory/unified/agentdb-adapter.js";
import { FileMemoryManager } from "../memory/file-memory-manager.js";
import { runAutomaticMigration } from "../memory/unified/migration.js";
import { buildProviderChain } from "../agents/providers/provider-registry.js";
import { ProviderManager } from "../agents/providers/provider-manager.js";
import type { Config } from "../config/config.js";
import type * as winston from "winston";
import { CachedEmbeddingProvider } from "../rag/embeddings/embedding-cache.js";

// Create a mock logger
function createMockLogger(): winston.Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as winston.Logger;
}

// Create a minimal test config
function createTestConfig(overrides: {
  enabled?: boolean;
  backend?: "agentdb" | "file";
  ragEnabled?: boolean;
  providerChain?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  kimiApiKey?: string;
} = {}): Config {
  return {
    anthropicApiKey: overrides.anthropicApiKey,
    geminiApiKey: overrides.geminiApiKey,
    kimiApiKey: overrides.kimiApiKey,
    openaiApiKey: undefined,
    deepseekApiKey: undefined,
    qwenApiKey: undefined,
    minimaxApiKey: undefined,
    groqApiKey: undefined,
    mistralApiKey: undefined,
    togetherApiKey: undefined,
    fireworksApiKey: undefined,
    providerChain: overrides.providerChain,
    providerModels: {},
    memory: {
      enabled: overrides.enabled ?? true,
      dbPath: "/tmp/test-memory",
      backend: overrides.backend ?? "agentdb",
      unified: {
        dimensions: 768,
        autoTiering: false,
        tierLimits: {
          working: 50,
          ephemeral: 500,
          persistent: 5000,
        },
        ephemeralTtlHours: 24,
      },
      decay: {
        enabled: true,
        lambdas: { working: 0.10, ephemeral: 0.05, persistent: 0.01 },
        exemptDomains: ["instinct"],
        timeoutMs: 30000,
      },
    },
    rag: {
      enabled: overrides.ragEnabled ?? false,
      provider: "auto" as const,
      contextMaxTokens: 4096,
    },
  } as Config;
}

// Helper to reset mocks to default successful behavior
function resetMocksToDefaults(): void {
  vi.mocked(AgentDBMemory).mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue({ kind: "ok", value: undefined }),
    shutdown: vi.fn(),
    setDecayConfig: vi.fn(),
  }) as unknown as InstanceType<typeof AgentDBMemory>);

  vi.mocked(AgentDBAdapter).mockImplementation((agentdb: unknown) => ({
    _agentdb: agentdb,
    _isAdapter: true,
  }) as unknown as InstanceType<typeof AgentDBAdapter>);

  vi.mocked(FileMemoryManager).mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    _isFileManager: true,
  }) as unknown as InstanceType<typeof FileMemoryManager>);
}

describe("initializeMemory", () => {
  let logger: winston.Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMocksToDefaults();
    resolveEmbeddingProviderMock.mockReset();
    cachedEmbeddingInitializeMock.mockResolvedValue(undefined);
    cachedEmbeddingEmbedMock.mockResolvedValue({
      embeddings: [[0.1, 0.2, 0.3]],
      dimensions: 3,
    });
    logger = createMockLogger();
  });

  it("should return undefined when memory is disabled", async () => {
    const config = createTestConfig({ enabled: false });
    const result = await initializeMemory(config, logger);
    expect(result).toBeUndefined();
  });

  it("should create AgentDBMemory + AgentDBAdapter when backend is 'agentdb'", async () => {
    const config = createTestConfig({ backend: "agentdb" });
    const result = await initializeMemory(config, logger);

    expect(AgentDBMemory).toHaveBeenCalledTimes(1);
    expect(AgentDBAdapter).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    expect((result as Record<string, unknown>)._isAdapter).toBe(true);
  });

  it("should create FileMemoryManager when backend is 'file'", async () => {
    const config = createTestConfig({ backend: "file" });
    const result = await initializeMemory(config, logger);

    expect(FileMemoryManager).toHaveBeenCalledTimes(1);
    expect(AgentDBMemory).not.toHaveBeenCalled();
    expect(result).toBeDefined();
    expect((result as Record<string, unknown>)._isFileManager).toBe(true);
  });

  it("should attempt schema repair and retry when AgentDB init fails", async () => {
    let callCount = 0;
    vi.mocked(AgentDBMemory).mockImplementation(() => ({
      initialize: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { kind: "err", error: new Error("init failed") };
        }
        return { kind: "ok", value: undefined };
      }),
      shutdown: vi.fn(),
      setDecayConfig: vi.fn(),
    }) as unknown as InstanceType<typeof AgentDBMemory>);

    const config = createTestConfig({ backend: "agentdb" });
    const result = await initializeMemory(config, logger);

    // Should have created AgentDBMemory twice (initial + retry)
    expect(AgentDBMemory).toHaveBeenCalledTimes(2);
    // Should have succeeded on retry
    expect(result).toBeDefined();
    expect((result as Record<string, unknown>)._isAdapter).toBe(true);
    // Should have logged about recovery
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("recovered"),
      expect.any(Object),
    );
  });

  it("should fall back to FileMemoryManager when AgentDB init fails and repair fails", async () => {
    vi.mocked(AgentDBMemory).mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue({ kind: "err", error: new Error("init failed") }),
      shutdown: vi.fn(),
      setDecayConfig: vi.fn(),
    }) as unknown as InstanceType<typeof AgentDBMemory>);

    const config = createTestConfig({ backend: "agentdb" });
    const result = await initializeMemory(config, logger);

    // Should have tried AgentDB twice (initial + retry after repair)
    expect(AgentDBMemory).toHaveBeenCalledTimes(2);
    // Should have fallen back to FileMemoryManager
    expect(FileMemoryManager).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    expect((result as Record<string, unknown>)._isFileManager).toBe(true);
    // Should have logged fallback warning
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("falling back"),
      expect.any(Object),
    );
  });

  it("should pass correct config values to AgentDBMemory constructor", async () => {
    const config = createTestConfig({ backend: "agentdb" });
    await initializeMemory(config, logger);

    const constructorArg = vi.mocked(AgentDBMemory).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(constructorArg).toBeDefined();
    expect(constructorArg.dbPath).toBe("/tmp/test-memory/agentdb");
    expect(constructorArg.dimensions).toBe(768);
    expect(constructorArg.enableAutoTiering).toBe(false);
    expect(constructorArg.maxEntriesPerTier).toEqual({
      working: 50,
      ephemeral: 500,
      persistent: 5000,
    });
    // ephemeralTtlHours * 3600000 = 24 * 3600000 = 86400000
    expect(constructorArg.ephemeralTtlMs).toBe(86400000);
  });

  it("should log hash-based embedding warning when RAG is not enabled", async () => {
    const config = createTestConfig({ backend: "agentdb", ragEnabled: false });
    await initializeMemory(config, logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("hash-based fallback"),
    );
  });

  it("should return undefined when FileMemoryManager init fails on file backend", async () => {
    vi.mocked(FileMemoryManager).mockImplementation(() => ({
      initialize: vi.fn().mockRejectedValue(new Error("file init failed")),
      _isFileManager: true,
    }) as unknown as InstanceType<typeof FileMemoryManager>);

    const config = createTestConfig({ backend: "file" });
    const result = await initializeMemory(config, logger);

    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("keeps embeddings active for memory when RAG is disabled", async () => {
    resolveEmbeddingProviderMock.mockReturnValue({
      provider: {
        name: "Gemini:gemini-embedding-2-preview",
        dimensions: 3072,
      },
      source: "auto-fallback:gemini",
    });

    const config = createTestConfig({
      backend: "agentdb",
      ragEnabled: false,
      enabled: true,
      geminiApiKey: "gemini-key",
      providerChain: "kimi",
    });
    const result = await resolveAndCacheEmbeddings(config, logger);

    expect(resolveEmbeddingProviderMock).toHaveBeenCalledWith(config);
    expect(CachedEmbeddingProvider).toHaveBeenCalledTimes(1);
    expect(result.cachedProvider).toBeDefined();
    expect(result.status).toEqual(expect.objectContaining({
      state: "active",
      ragEnabled: false,
      configuredProvider: "auto",
      resolvedProviderName: "Gemini:gemini-embedding-2-preview",
      resolutionSource: "auto-fallback:gemini",
      activeDimensions: 3072,
      usingHashFallback: false,
    }));
  });

  it("disables embeddings only when both RAG and memory are disabled", async () => {
    const config = createTestConfig({ enabled: false, ragEnabled: false });
    const result = await resolveAndCacheEmbeddings(config, logger);

    expect(resolveEmbeddingProviderMock).not.toHaveBeenCalled();
    expect(result.cachedProvider).toBeUndefined();
    expect(result.status).toEqual(expect.objectContaining({
      state: "disabled",
      ragEnabled: false,
      usingHashFallback: true,
      notice: "RAG and semantic memory are disabled by configuration",
    }));
  });

  it("reports an actionable notice when the response chain has no embedding-capable provider", async () => {
    resolveEmbeddingProviderMock.mockReturnValue(null);
    const config = createTestConfig({
      backend: "agentdb",
      ragEnabled: true,
      enabled: true,
      providerChain: "kimi",
    });

    const result = await resolveAndCacheEmbeddings(config, logger);

    expect(result.cachedProvider).toBeUndefined();
    expect(result.status.usingHashFallback).toBe(true);
    expect(result.status.notice).toContain("PROVIDER_CHAIN only contains non-embedding providers (kimi)");
    expect(result.status.notice).toContain("Configure an embedding-capable provider such as Gemini");
  });

  it("reports which credential is missing when the chain includes an embedding-capable provider", async () => {
    resolveEmbeddingProviderMock.mockReturnValue(null);
    const config = createTestConfig({
      backend: "agentdb",
      ragEnabled: true,
      enabled: true,
      providerChain: "gemini,kimi",
    });

    const result = await resolveAndCacheEmbeddings(config, logger);

    expect(result.cachedProvider).toBeUndefined();
    expect(result.status.usingHashFallback).toBe(true);
    expect(result.status.notice).toContain("embedding-capable providers in PROVIDER_CHAIN are missing credentials (gemini)");
    expect(result.status.notice).toContain("GEMINI_API_KEY");
  });

  describe("legacy memory migration", () => {
    it("should call runAutomaticMigration after successful AgentDB init", async () => {
      const config = createTestConfig({ backend: "agentdb" });
      await initializeMemory(config, logger);

      expect(runAutomaticMigration).toHaveBeenCalledTimes(1);
      // First arg should be config.memory.dbPath (where memory.json lives)
      expect(runAutomaticMigration).toHaveBeenCalledWith(
        "/tmp/test-memory",
        expect.anything(), // agentdb instance
      );
    });

    it("should skip migration when it returns null (marker exists or no memory.json)", async () => {
      vi.mocked(runAutomaticMigration).mockResolvedValue(null);
      const config = createTestConfig({ backend: "agentdb" });
      const result = await initializeMemory(config, logger);

      // Should still return a valid adapter
      expect(result).toBeDefined();
      expect((result as Record<string, unknown>)._isAdapter).toBe(true);
      // Should not log migration completion
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining("Legacy memory migration completed"),
        expect.anything(),
      );
    });

    it("should not block agent startup when migration fails", async () => {
      vi.mocked(runAutomaticMigration).mockRejectedValue(new Error("migration exploded"));
      const config = createTestConfig({ backend: "agentdb" });
      const result = await initializeMemory(config, logger);

      // Agent should still boot with AgentDB
      expect(result).toBeDefined();
      expect((result as Record<string, unknown>)._isAdapter).toBe(true);
      // Should log warning about migration failure
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("migration failed"),
        expect.objectContaining({ error: "migration exploded" }),
      );
    });

    it("should not call migration on file backend", async () => {
      const config = createTestConfig({ backend: "file" });
      await initializeMemory(config, logger);

      expect(runAutomaticMigration).not.toHaveBeenCalled();
    });

    it("should call migration after AgentDB init in repair path", async () => {
      let callCount = 0;
      vi.mocked(AgentDBMemory).mockImplementation(() => ({
        initialize: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return { kind: "err", error: new Error("init failed") };
          }
          return { kind: "ok", value: undefined };
        }),
        shutdown: vi.fn(),
        setDecayConfig: vi.fn(),
      }) as unknown as InstanceType<typeof AgentDBMemory>);

      const config = createTestConfig({ backend: "agentdb" });
      await initializeMemory(config, logger);

      // Migration should still be called after recovery
      expect(runAutomaticMigration).toHaveBeenCalledTimes(1);
    });
  });
});

describe("isTransientEmbeddingVerificationError", () => {
  it("treats network-style startup failures as transient", () => {
    expect(isTransientEmbeddingVerificationError(new Error("fetch failed"))).toBe(true);
    expect(isTransientEmbeddingVerificationError(new Error("Gemini API error 503: upstream unavailable"))).toBe(true);
    expect(isTransientEmbeddingVerificationError(new Error("request timed out"))).toBe(true);
  });

  it("does not treat auth and configuration failures as transient", () => {
    expect(isTransientEmbeddingVerificationError(new Error("OpenAI API error 401: invalid_api_key"))).toBe(false);
    expect(isTransientEmbeddingVerificationError(new Error("OpenAI API error 403: permission denied"))).toBe(false);
    expect(isTransientEmbeddingVerificationError(new Error("OpenAI API error 404: model not found"))).toBe(false);
  });
});

describe("initializeAIProvider", () => {
  let logger: winston.Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
  });

  it("skips unavailable providers in the configured chain and continues", async () => {
    const config = createTestConfig({
      providerChain: "kimi,gemini",
      geminiApiKey: "gem-key",
    });

    const result = await initializeAIProvider(config, logger);

    expect(buildProviderChain).toHaveBeenCalledWith(
      ["gemini"],
      expect.objectContaining({
        gemini: expect.objectContaining({ apiKey: "gem-key" }),
        kimi: expect.objectContaining({ apiKey: undefined }),
      }),
      expect.any(Object),
    );
    expect(result.notices).toContain("Unavailable AI providers were skipped: kimi.");
    expect(result.manager).toBeDefined();
  });

  it("falls back to detected providers when the configured chain has no usable providers", async () => {
    const config = createTestConfig({
      providerChain: "kimi",
      geminiApiKey: "gem-key",
    });

    const result = await initializeAIProvider(config, logger);

    expect(buildProviderChain).toHaveBeenCalledWith(
      ["gemini"],
      expect.objectContaining({
        gemini: expect.objectContaining({ apiKey: "gem-key" }),
      }),
      expect.any(Object),
    );
    expect(result.notices).toContain(
      "Configured provider chain had no usable providers. Falling back to: gemini.",
    );
    expect(ProviderManager).toHaveBeenCalledTimes(1);
  });
});
