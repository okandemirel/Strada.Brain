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
} from "./bootstrap-memory.js";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";

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
