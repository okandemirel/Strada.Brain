import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadConfig, resetConfigCache } from "./config.js";
import { realpathSync, statSync } from "node:fs";

vi.mock("node:fs", () => ({
  realpathSync: vi.fn((p: string) => p),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}));

vi.mock("dotenv", () => ({
  default: { config: vi.fn() },
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
    vi.clearAllMocks();
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
    expect(config.telegramBotToken).toBe("bot-token-123");
  });

  it("parses CSV user IDs correctly", () => {
    setEnv({ ALLOWED_TELEGRAM_USER_IDS: "1,2,3" });
    const config = loadConfig();
    expect(config.allowedTelegramUserIds).toEqual([1, 2, 3]);
  });

  it("applies default values", () => {
    setEnv();
    const config = loadConfig();
    expect(config.requireEditConfirmation).toBe(true);
    expect(config.readOnlyMode).toBe(false);
    expect(config.logLevel).toBe("info");
    expect(config.logFile).toBe("strata-brain.log");
  });

  it("parses boolean strings correctly", () => {
    setEnv({
      REQUIRE_EDIT_CONFIRMATION: "false",
      READ_ONLY_MODE: "true",
    });
    const config = loadConfig();
    expect(config.requireEditConfirmation).toBe(false);
    expect(config.readOnlyMode).toBe(true);
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
});
