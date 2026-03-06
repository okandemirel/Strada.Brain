import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadConfig, resetConfigCache, validateConfig } from "./config.js";
import { realpathSync, statSync } from "node:fs";

vi.mock("node:fs", () => ({
  realpathSync: vi.fn((p: string) => p),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}));

vi.mock("dotenv", () => ({
  config: vi.fn(),
}));

function setEnv(overrides: Record<string, string | undefined> = {}) {
  const defaults: Record<string, string> = {
    ANTHROPIC_API_KEY: "sk-test-key-123",
    UNITY_PROJECT_PATH: "/test/project",
  };
  const merged = { ...defaults, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("loadConfig", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.mocked(realpathSync).mockImplementation((p) => String(p));
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof statSync>);
    // Clear relevant env vars
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["TELEGRAM_BOT_TOKEN"];
    delete process.env["ALLOWED_TELEGRAM_USER_IDS"];
    delete process.env["REQUIRE_EDIT_CONFIRMATION"];
    delete process.env["READ_ONLY_MODE"];
    delete process.env["UNITY_PROJECT_PATH"];
    delete process.env["LOG_LEVEL"];
    delete process.env["LOG_FILE"];
    // Clear unified memory env vars
    delete process.env["MEMORY_BACKEND"];
    delete process.env["MEMORY_DIMENSIONS"];
    delete process.env["MEMORY_AUTO_TIERING"];
    delete process.env["MEMORY_TIER_WORKING_MAX"];
    delete process.env["MEMORY_TIER_EPHEMERAL_MAX"];
    delete process.env["MEMORY_TIER_PERSISTENT_MAX"];
    delete process.env["MEMORY_EPHEMERAL_TTL_HOURS"];
  });

  it("loads valid configuration", () => {
    setEnv();
    const config = loadConfig();
    expect(config.anthropicApiKey).toBe("sk-test-key-123");
    expect(config.unityProjectPath).toBe("/test/project");
  });

  it("throws when ANTHROPIC_API_KEY is missing", () => {
    setEnv({ ANTHROPIC_API_KEY: undefined });
    delete process.env["ANTHROPIC_API_KEY"];
    expect(() => loadConfig()).toThrow("Invalid configuration");
  });

  it("throws when UNITY_PROJECT_PATH is missing", () => {
    setEnv({ UNITY_PROJECT_PATH: undefined });
    delete process.env["UNITY_PROJECT_PATH"];
    expect(() => loadConfig()).toThrow("Invalid configuration");
  });

  it("accepts optional telegramBotToken", () => {
    setEnv();
    const config = loadConfig();
    expect(config.telegramBotToken).toBeUndefined();
  });

  it("sets telegramBotToken when provided", () => {
    setEnv({ TELEGRAM_BOT_TOKEN: "bot-token-123" });
    const config = loadConfig();
    expect(config.telegram.botToken).toBe("bot-token-123");
  });

  it("parses CSV user IDs correctly", () => {
    setEnv({ ALLOWED_TELEGRAM_USER_IDS: "1,2,3" });
    const config = loadConfig();
    expect(config.telegram.allowedUserIds).toEqual([1, 2, 3]);
  });

  it("applies default values", () => {
    setEnv();
    const config = loadConfig();
    expect(config.security.requireEditConfirmation).toBe(true);
    expect(config.security.readOnlyMode).toBe(false);
    expect(config.logLevel).toBe("info");
    expect(config.logFile).toBe("strata-brain.log");
  });

  it("parses boolean strings correctly", () => {
    setEnv({
      REQUIRE_EDIT_CONFIRMATION: "false",
      READ_ONLY_MODE: "true",
    });
    const config = loadConfig();
    expect(config.security.requireEditConfirmation).toBe(false);
    expect(config.security.readOnlyMode).toBe(true);
  });

  it("caches config on subsequent calls", () => {
    setEnv();
    const config1 = loadConfig();
    const config2 = loadConfig();
    expect(config1).toBe(config2); // same reference
  });

  it("resets cache with resetConfigCache", () => {
    setEnv();
    const config1 = loadConfig();
    resetConfigCache();
    const config2 = loadConfig();
    expect(config1).not.toBe(config2);
  });

  it("throws when project path does not exist", () => {
    setEnv();
    vi.mocked(realpathSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(() => loadConfig()).toThrow("does not exist");
  });

  it("throws when project path is not a directory", () => {
    setEnv();
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as ReturnType<typeof statSync>);
    expect(() => loadConfig()).toThrow("not a directory");
  });

  it("resolves symlinked project path", () => {
    setEnv();
    vi.mocked(realpathSync).mockReturnValue("/real/path");
    const config = loadConfig();
    expect(config.unityProjectPath).toBe("/real/path");
  });

  // =========================================================================
  // Unified Memory Config Tests (MEM-07)
  // =========================================================================

  describe("unified memory config", () => {
    it("includes backend field with default 'agentdb'", () => {
      setEnv();
      const config = loadConfig();
      expect(config.memory.backend).toBe("agentdb");
    });

    it("includes unified sub-object with correct defaults", () => {
      setEnv();
      const config = loadConfig();
      expect(config.memory.unified).toEqual({
        dimensions: 1536,
        autoTiering: false,
        tierLimits: {
          working: 100,
          ephemeral: 1000,
          persistent: 10000,
        },
        ephemeralTtlHours: 24,
      });
    });

    it("accepts MEMORY_BACKEND=agentdb", () => {
      setEnv({ MEMORY_BACKEND: "agentdb" });
      const config = loadConfig();
      expect(config.memory.backend).toBe("agentdb");
    });

    it("accepts MEMORY_BACKEND=file", () => {
      setEnv({ MEMORY_BACKEND: "file" });
      const config = loadConfig();
      expect(config.memory.backend).toBe("file");
    });

    it("rejects invalid MEMORY_BACKEND value", () => {
      setEnv({ MEMORY_BACKEND: "invalid" });
      expect(() => loadConfig()).toThrow();
    });

    it("validates MEMORY_DIMENSIONS range 64-4096", () => {
      setEnv({ MEMORY_DIMENSIONS: "768" });
      const config = loadConfig();
      expect(config.memory.unified.dimensions).toBe(768);
    });

    it("rejects MEMORY_DIMENSIONS below minimum", () => {
      setEnv({ MEMORY_DIMENSIONS: "32" });
      expect(() => loadConfig()).toThrow();
    });

    it("rejects MEMORY_DIMENSIONS above maximum", () => {
      setEnv({ MEMORY_DIMENSIONS: "5000" });
      expect(() => loadConfig()).toThrow();
    });

    it("rejects non-numeric MEMORY_DIMENSIONS", () => {
      setEnv({ MEMORY_DIMENSIONS: "abc" });
      expect(() => loadConfig()).toThrow();
    });

    it("converts MEMORY_AUTO_TIERING string to boolean", () => {
      setEnv({ MEMORY_AUTO_TIERING: "true" });
      const config = loadConfig();
      expect(config.memory.unified.autoTiering).toBe(true);
    });

    it("defaults MEMORY_AUTO_TIERING to false", () => {
      setEnv();
      const config = loadConfig();
      expect(config.memory.unified.autoTiering).toBe(false);
    });

    it("validates MEMORY_TIER_WORKING_MAX as positive integer", () => {
      setEnv({ MEMORY_TIER_WORKING_MAX: "200" });
      const config = loadConfig();
      expect(config.memory.unified.tierLimits.working).toBe(200);
    });

    it("validates MEMORY_TIER_EPHEMERAL_MAX as positive integer", () => {
      setEnv({ MEMORY_TIER_EPHEMERAL_MAX: "5000" });
      const config = loadConfig();
      expect(config.memory.unified.tierLimits.ephemeral).toBe(5000);
    });

    it("validates MEMORY_TIER_PERSISTENT_MAX as positive integer", () => {
      setEnv({ MEMORY_TIER_PERSISTENT_MAX: "50000" });
      const config = loadConfig();
      expect(config.memory.unified.tierLimits.persistent).toBe(50000);
    });

    it("validates MEMORY_EPHEMERAL_TTL_HOURS as positive integer", () => {
      setEnv({ MEMORY_EPHEMERAL_TTL_HOURS: "48" });
      const config = loadConfig();
      expect(config.memory.unified.ephemeralTtlHours).toBe(48);
    });

    it("default config (no env vars) produces valid MemoryConfig with all unified fields", () => {
      setEnv();
      const config = loadConfig();
      expect(config.memory).toEqual({
        enabled: true,
        dbPath: ".strata-memory",
        backend: "agentdb",
        unified: {
          dimensions: 1536,
          autoTiering: false,
          tierLimits: {
            working: 100,
            ephemeral: 1000,
            persistent: 10000,
          },
          ephemeralTtlHours: 24,
        },
      });
    });
  });
});
