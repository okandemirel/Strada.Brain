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

// Mock modules before imports
vi.mock("../memory/unified/agentdb-memory.js", () => {
  const MockAgentDBMemory = vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue({ kind: "ok", value: undefined }),
    shutdown: vi.fn(),
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

// Import the function under test
import { initializeMemory } from "./bootstrap.js";
import { AgentDBMemory } from "../memory/unified/agentdb-memory.js";
import { AgentDBAdapter } from "../memory/unified/agentdb-adapter.js";
import { FileMemoryManager } from "../memory/file-memory-manager.js";
import { runAutomaticMigration } from "../memory/unified/migration.js";
import type { Config } from "../config/config.js";
import type * as winston from "winston";

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
} = {}): Config {
  return {
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
      }) as unknown as InstanceType<typeof AgentDBMemory>);

      const config = createTestConfig({ backend: "agentdb" });
      await initializeMemory(config, logger);

      // Migration should still be called after recovery
      expect(runAutomaticMigration).toHaveBeenCalledTimes(1);
    });
  });
});
