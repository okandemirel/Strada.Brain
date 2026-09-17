import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config } from "../config/config.js";
import type * as winston from "winston";

// ---------------------------------------------------------------------------
// Mocks — must be declared before the module under test is imported
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("better-sqlite3", () => {
  const mockDb = {
    pragma: vi.fn(),
    prepare: vi.fn().mockReturnValue({ get: vi.fn() }),
    close: vi.fn(),
  };
  return { default: vi.fn(function () { return mockDb; }) };
});

const mockAgentDBInitialize = vi.fn();
const mockStartAutoTiering = vi.fn();
const mockSetDecayConfig = vi.fn();

vi.mock("../memory/unified/agentdb-memory.js", () => ({
  AgentDBMemory: vi.fn().mockImplementation(function () {
    return {
      initialize: mockAgentDBInitialize,
      startAutoTiering: mockStartAutoTiering,
      setDecayConfig: mockSetDecayConfig,
    };
  }),
}));

vi.mock("../memory/unified/agentdb-adapter.js", () => ({
  AgentDBAdapter: vi.fn().mockImplementation(function (agentdb: unknown) {
    return { _tag: "agentdb-adapter", _inner: agentdb };
  }),
}));

const mockRunAutomaticMigration = vi.fn();
vi.mock("../memory/unified/migration.js", () => ({
  runAutomaticMigration: (...args: unknown[]) => mockRunAutomaticMigration(...args),
}));

const mockFileMemoryInitialize = vi.fn();
vi.mock("../memory/file-memory-manager.js", () => ({
  FileMemoryManager: vi.fn().mockImplementation(function () {
    return {
      initialize: mockFileMemoryInitialize,
      _tag: "file-memory-manager",
    };
  }),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import {
  initializeMemory,
  attemptSchemaRepair,
  triggerLegacyMigration,
  initializeFileMemory,
  embeddingProviderIdentity,
  embeddingModelId,
  _resetWeakIdentityLog,
} from "./bootstrap-memory.js";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { AgentDBMemory } from "../memory/unified/agentdb-memory.js";
import type { CachedEmbeddingProvider } from "../rag/embeddings/embedding-cache.js";

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

function makeMemoryConfig(overrides: Partial<Config["memory"]> = {}): Config["memory"] {
  return {
    enabled: true,
    dbPath: "/tmp/test-memory",
    backend: "agentdb",
    unified: {
      dimensions: 768,
      autoTiering: false,
      autoTieringIntervalMs: 60000,
      promotionThreshold: 0.75,
      demotionTimeoutDays: 30,
      tierLimits: { working: 100, ephemeral: 500, persistent: 2000 },
      ephemeralTtlHours: 72,
    },
    decay: {
      enabled: false,
      lambdas: { working: 0.01, ephemeral: 0.005, persistent: 0.001 },
      exemptDomains: [],
      timeoutMs: 5000,
    },
    consolidation: {
      enabled: false,
      idleMinutes: 15,
      threshold: 0.8,
      batchSize: 10,
      minClusterSize: 3,
      maxDepth: 3,
      modelTier: "cheap",
    },
    ...overrides,
  } as Config["memory"];
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    memory: makeMemoryConfig(),
    rag: { enabled: false, provider: "auto", contextMaxTokens: 4000 },
    ...overrides,
  } as Config;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bootstrap-memory", () => {
  let logger: winston.Logger;

  beforeEach(() => {
    logger = createMockLogger();
    vi.clearAllMocks();
    mockAgentDBInitialize.mockResolvedValue({ kind: "ok" });
    mockRunAutomaticMigration.mockResolvedValue(undefined);
    mockFileMemoryInitialize.mockResolvedValue({ kind: "ok" });
  });

  // ========================================================================
  // initializeMemory
  // ========================================================================

  describe("initializeMemory", () => {
    it("returns undefined when memory is disabled", async () => {
      const config = makeConfig({ memory: makeMemoryConfig({ enabled: false }) });
      const result = await initializeMemory(config, logger);
      expect(result).toBeUndefined();
    });

    it("uses FileMemoryManager directly when backend is 'file'", async () => {
      const config = makeConfig({ memory: makeMemoryConfig({ backend: "file" }) });
      const result = await initializeMemory(config, logger);
      expect(result).toBeDefined();
      expect((result as any)._tag).toBe("file-memory-manager");
      expect(mockFileMemoryInitialize).toHaveBeenCalled();
    });

    it("initializes AgentDB successfully on first attempt", async () => {
      const config = makeConfig();
      const result = await initializeMemory(config, logger);
      expect(result).toBeDefined();
      expect((result as any)._tag).toBe("agentdb-adapter");
      expect(mockAgentDBInitialize).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        "AgentDB memory initialized",
        expect.objectContaining({ dbPath: expect.any(String) }),
      );
    });

    it("enables auto-tiering when configured", async () => {
      const config = makeConfig({
        memory: makeMemoryConfig({
          unified: {
            dimensions: 768,
            autoTiering: true,
            autoTieringIntervalMs: 30000,
            promotionThreshold: 0.8,
            demotionTimeoutDays: 14,
            tierLimits: { working: 100, ephemeral: 500, persistent: 2000 },
            ephemeralTtlHours: 72,
          },
        }),
      });

      await initializeMemory(config, logger);
      expect(mockStartAutoTiering).toHaveBeenCalledWith(30000, 0.8, 14);
    });

    it("sets decay config on AgentDB", async () => {
      const config = makeConfig();
      await initializeMemory(config, logger);
      expect(mockSetDecayConfig).toHaveBeenCalledWith(config.memory.decay);
    });

    it("warns when no embedding provider is available", async () => {
      const config = makeConfig();
      await initializeMemory(config, logger, undefined);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("hash-based fallback embeddings"),
      );
    });

    // Codex adversarial review 2026-09-17 round 6 #17: embeddingProviderId was
    // never set, so every model's vectors shared provenance "provider".
    describe("embedding provider identity (Codex round 6 #17)", () => {
      function provider(name: string, dimensions: number, model?: string) {
        return {
          name,
          dimensions,
          ...(model !== undefined ? { model } : {}),
          embed: vi.fn(async () => ({ embeddings: [new Array(dimensions).fill(0.1)], usage: { totalTokens: 1 } })),
        } as unknown as CachedEmbeddingProvider;
      }

      it("passes a stable id built from name, model and dimensions into the AgentDB config", async () => {
        await initializeMemory(makeConfig(), logger, provider("openai:text-embedding-3-small", 1536));
        const cfg = vi.mocked(AgentDBMemory).mock.calls[0]![0] as { embeddingProviderId?: string; dimensions: number };
        expect(cfg.embeddingProviderId).toBe("openai:text-embedding-3-small:1536d");
        expect(cfg.dimensions).toBe(1536);
      });

      it("two models never share an id; the same model always gets the same id", () => {
        const a = embeddingProviderIdentity(provider("openai:text-embedding-3-small", 1536));
        const b = embeddingProviderIdentity(provider("ollama:nomic-embed-text", 768));
        const sameNameOtherDims = embeddingProviderIdentity(provider("openai:text-embedding-3-small", 256));
        expect(a).not.toBe(b);
        expect(a).not.toBe(sameNameOtherDims);
        expect(embeddingProviderIdentity(provider("openai:text-embedding-3-small", 1536))).toBe(a);
        // a public model field is folded in only when the name does not already carry it
        expect(embeddingProviderIdentity(provider("custom", 8, "my-model"))).toBe("custom:my-model:8d");
        expect(embeddingProviderIdentity(provider("custom:my-model", 8, "my-model"))).toBe("custom:my-model:8d");
      });

      it("leaves embeddingProviderId unset without a provider (histogram index)", async () => {
        await initializeMemory(makeConfig(), logger, undefined);
        const cfg = vi.mocked(AgentDBMemory).mock.calls[0]![0] as { embeddingProviderId?: string };
        expect(cfg.embeddingProviderId).toBeUndefined();
      });

      it("reports unknown-provenance and foreign-provider vectors the re-embed pass repaired", async () => {
        const reEmbed = vi.fn(async () => ({
          migrated: 3, total: 10, skipped: 7, hashDetected: 1, unknownDetected: 1, foreignDetected: 1,
        }));
        vi.mocked(AgentDBMemory).mockImplementationOnce(function () {
          return {
            initialize: mockAgentDBInitialize,
            startAutoTiering: mockStartAutoTiering,
            setDecayConfig: mockSetDecayConfig,
            reEmbedHashEntries: reEmbed,
          } as unknown as AgentDBMemory;
        });
        await initializeMemory(makeConfig(), logger, provider("openai:text-embedding-3-small", 1536));
        await new Promise((r) => setTimeout(r, 0));
        expect(reEmbed).toHaveBeenCalledOnce();
        expect(logger.info).toHaveBeenCalledWith(
          expect.stringContaining("Re-embedded 3/3 stale entries (1 hash, 1 unknown provenance, 1 other provider) out of 10 scanned"),
        );
      });
    });

    it("falls back to FileMemoryManager after AgentDB init failure and repair failure", async () => {
      mockAgentDBInitialize.mockRejectedValue(new Error("corrupt database"));

      const config = makeConfig();
      const result = await initializeMemory(config, logger);

      expect(result).toBeDefined();
      expect((result as any)._tag).toBe("file-memory-manager");
      expect(logger.warn).toHaveBeenCalledWith(
        "AgentDB initialization failed, attempting schema repair",
        expect.any(Object),
      );
    });

    it("recovers AgentDB after successful schema repair", async () => {
      // First attempt fails, second succeeds
      let callCount = 0;
      mockAgentDBInitialize.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error("corrupt");
        return { kind: "ok" };
      });

      const config = makeConfig();
      const result = await initializeMemory(config, logger);

      expect(result).toBeDefined();
      expect((result as any)._tag).toBe("agentdb-adapter");
      expect(logger.info).toHaveBeenCalledWith(
        "AgentDB recovered after schema repair",
        expect.any(Object),
      );
    });

    it("handles AgentDB returning err result", async () => {
      mockAgentDBInitialize.mockResolvedValue({
        kind: "err",
        error: new Error("schema mismatch"),
      });

      const config = makeConfig();
      const result = await initializeMemory(config, logger);

      // Should attempt repair and ultimately fall back
      expect(result).toBeDefined();
      expect(logger.warn).toHaveBeenCalledWith(
        "AgentDB initialization failed, attempting schema repair",
        expect.any(Object),
      );
    });
  });

  // ========================================================================
  // attemptSchemaRepair
  // ========================================================================

  describe("attemptSchemaRepair", () => {
    it("returns true when DB file does not exist (fresh DB)", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const result = await attemptSchemaRepair("/tmp/test-db", logger);
      expect(result).toBe(true);
    });

    it("returns true when DB file exists and SELECT succeeds", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const result = await attemptSchemaRepair("/tmp/test-db", logger);
      expect(result).toBe(true);
    });

    it("returns true and logs info when memories table is missing", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const mockDb = {
        pragma: vi.fn(),
        prepare: vi.fn().mockImplementation(() => {
          throw new Error("no such table: memories");
        }),
        close: vi.fn(),
      };
      vi.mocked(Database).mockImplementationOnce(function () { return mockDb as any; });

      const result = await attemptSchemaRepair("/tmp/test-db", logger);
      expect(result).toBe(true);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("memories table will be recreated"),
      );
    });

    it("returns false when Database constructor throws", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(Database).mockImplementationOnce(function () {
        throw new Error("database is locked");
      });

      const result = await attemptSchemaRepair("/tmp/test-db", logger);
      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        "AgentDB schema repair failed",
        expect.objectContaining({ error: "database is locked" }),
      );
    });
  });

  // ========================================================================
  // triggerLegacyMigration
  // ========================================================================

  describe("triggerLegacyMigration", () => {
    it("logs migration results when migration succeeds", async () => {
      mockRunAutomaticMigration.mockResolvedValue({
        entriesMigrated: 10,
        entriesFailed: 1,
        errors: ["minor issue"],
      });

      const agentdb = {} as any;
      const config = makeConfig();
      await triggerLegacyMigration(config, agentdb, logger);

      expect(logger.info).toHaveBeenCalledWith(
        "Legacy memory migration completed",
        expect.objectContaining({
          migrated: 10,
          failed: 1,
          errors: 1,
        }),
      );
    });

    it("does not log when migration returns null/undefined", async () => {
      mockRunAutomaticMigration.mockResolvedValue(undefined);

      await triggerLegacyMigration(makeConfig(), {} as any, logger);
      expect(logger.info).not.toHaveBeenCalledWith(
        "Legacy memory migration completed",
        expect.any(Object),
      );
    });

    it("warns but does not throw when migration fails", async () => {
      mockRunAutomaticMigration.mockRejectedValue(new Error("disk full"));

      await expect(
        triggerLegacyMigration(makeConfig(), {} as any, logger),
      ).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledWith(
        "Legacy memory migration failed, continuing with empty AgentDB",
        expect.objectContaining({ error: "disk full" }),
      );
    });
  });

  // ========================================================================
  // initializeFileMemory
  // ========================================================================

  describe("initializeFileMemory", () => {
    it("initializes and returns FileMemoryManager", async () => {
      const config = makeConfig();
      const result = await initializeFileMemory(config, logger);
      expect(result).toBeDefined();
      expect((result as any)._tag).toBe("file-memory-manager");
      expect(logger.info).toHaveBeenCalledWith(
        "FileMemoryManager initialized",
        expect.objectContaining({ dbPath: "/tmp/test-memory" }),
      );
    });

    it("returns undefined when initialization fails", async () => {
      mockFileMemoryInitialize.mockRejectedValue(new Error("permission denied"));

      const config = makeConfig();
      const result = await initializeFileMemory(config, logger);
      expect(result).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        "FileMemoryManager initialization failed",
        expect.objectContaining({ error: "permission denied" }),
      );
    });
  });
});

// Codex adversarial review 2026-09-17 round 7 #20: two custom models with the
// same name and dimension collided as "custom:8d", and the cache wrapper hid
// the inner provider's model.
describe("embedding provider identity uses the model id (Codex round 7 #20)", () => {
  beforeEach(() => _resetWeakIdentityLog());

  it("uses modelId when present, so two same-name same-dimension models get different ids", () => {
    const a = embeddingProviderIdentity({ name: "custom", dimensions: 8, modelId: "model-a" });
    const b = embeddingProviderIdentity({ name: "custom", dimensions: 8, modelId: "model-b" });
    expect(a).toBe("custom:model-a:8d");
    expect(b).toBe("custom:model-b:8d");
    expect(a).not.toBe(b);
    // the same model always gets the same id
    expect(embeddingProviderIdentity({ name: "custom", dimensions: 8, modelId: "model-a" })).toBe(a);
  });

  it("describeIdentity() wins over modelId/model; a describer that throws is ignored", () => {
    expect(embeddingModelId({ describeIdentity: () => "described-1", modelId: "m", model: "n" })).toBe("described-1");
    expect(embeddingModelId({ describeIdentity: () => { throw new Error("no"); }, modelId: "m" })).toBe("m");
    expect(embeddingModelId({ model: "plain-model" })).toBe("plain-model");
    expect(embeddingModelId({ name: "x" })).toBeUndefined();
  });

  it("a wrapper delegates to its inner provider's model id (cache wrapper case)", () => {
    const wrappedA = { name: "custom", dimensions: 8, inner: { name: "custom", dimensions: 8, modelId: "model-a" } };
    const wrappedB = { name: "custom", dimensions: 8, inner: { name: "custom", dimensions: 8, modelId: "model-b" } };
    expect(embeddingProviderIdentity(wrappedA)).toBe("custom:model-a:8d");
    expect(embeddingProviderIdentity(wrappedB)).toBe("custom:model-b:8d");
    // nested wrappers, and the other conventional field names
    expect(embeddingModelId({ provider: { wrapped: { modelId: "deep" } } })).toBe("deep");
  });

  it("falls back to name:dimensions only when nothing else is available, and logs the weak identity once", () => {
    const logger = createMockLogger();
    expect(embeddingProviderIdentity({ name: "custom", dimensions: 8 }, logger)).toBe("custom:8d");
    expect(embeddingProviderIdentity({ name: "other", dimensions: 8 }, logger)).toBe("other:8d");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("exposes no model id"));
    // a strong identity never logs
    const quiet = createMockLogger();
    _resetWeakIdentityLog();
    embeddingProviderIdentity({ name: "custom", dimensions: 8, modelId: "m" }, quiet);
    expect(quiet.warn).not.toHaveBeenCalled();
  });

  it("initializeMemory wires the batch embedder (round 7 #21) and the model-aware id into the AgentDB config", async () => {
    const embed = vi.fn(async (texts: string[]) => ({
      embeddings: texts.map(() => [0.1, 0.2]), usage: { totalTokens: texts.length },
    }));
    const provider = { name: "custom", dimensions: 2, modelId: "model-z", embed } as unknown as CachedEmbeddingProvider;
    await initializeMemory(makeConfig(), createMockLogger(), provider);
    const cfg = vi.mocked(AgentDBMemory).mock.calls[0]![0] as {
      embeddingProviderId?: string;
      embeddingProviderBatch?: (texts: string[]) => Promise<number[][]>;
    };
    expect(cfg.embeddingProviderId).toBe("custom:model-z:2d");
    expect(cfg.embeddingProviderBatch).toBeTypeOf("function");
    await expect(cfg.embeddingProviderBatch!(["a", "b", "c"])).resolves.toEqual([[0.1, 0.2], [0.1, 0.2], [0.1, 0.2]]);
    expect(embed).toHaveBeenCalledWith(["a", "b", "c"]);
  });
});
