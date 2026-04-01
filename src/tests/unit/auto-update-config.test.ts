import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig, resetConfigCache } from "../../config/config.js";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  realpathSync: vi.fn((p: string) => p),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}));

vi.mock("dotenv", () => ({
  config: vi.fn(),
}));

describe("Auto-Update Config", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetConfigCache();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetConfigCache();
  });

  it("should parse AUTO_UPDATE_ENABLED as boolean", () => {
    process.env["AUTO_UPDATE_ENABLED"] = "false";
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    const config = loadConfig();
    expect(config.autoUpdate.enabled).toBe(false);
  });

  it("should default AUTO_UPDATE_ENABLED to true", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    const config = loadConfig();
    expect(config.autoUpdate.enabled).toBe(true);
  });

  it("should parse AUTO_UPDATE_INTERVAL_HOURS as number", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    process.env["AUTO_UPDATE_INTERVAL_HOURS"] = "12";
    const config = loadConfig();
    expect(config.autoUpdate.intervalHours).toBe(12);
  });

  it("should default AUTO_UPDATE_INTERVAL_HOURS to 6", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    const config = loadConfig();
    expect(config.autoUpdate.intervalHours).toBe(6);
  });

  it("should parse AUTO_UPDATE_IDLE_TIMEOUT_MIN as number", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    process.env["AUTO_UPDATE_IDLE_TIMEOUT_MIN"] = "10";
    const config = loadConfig();
    expect(config.autoUpdate.idleTimeoutMin).toBe(10);
  });

  it("should default AUTO_UPDATE_IDLE_TIMEOUT_MIN to 5", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    const config = loadConfig();
    expect(config.autoUpdate.idleTimeoutMin).toBe(5);
  });

  it("should parse AUTO_UPDATE_CHANNEL as enum", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    process.env["AUTO_UPDATE_CHANNEL"] = "latest";
    const config = loadConfig();
    expect(config.autoUpdate.channel).toBe("latest");
  });

  it("should default AUTO_UPDATE_CHANNEL to stable", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    const config = loadConfig();
    expect(config.autoUpdate.channel).toBe("stable");
  });

  it("should reject invalid AUTO_UPDATE_CHANNEL", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    process.env["AUTO_UPDATE_CHANNEL"] = "nightly";
    expect(() => loadConfig()).toThrow();
  });

  it("should parse AUTO_UPDATE_NOTIFY as boolean", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    process.env["AUTO_UPDATE_NOTIFY"] = "false";
    const config = loadConfig();
    expect(config.autoUpdate.notify).toBe(false);
  });

  it("should parse AUTO_UPDATE_AUTO_RESTART as boolean", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    process.env["AUTO_UPDATE_AUTO_RESTART"] = "false";
    const config = loadConfig();
    expect(config.autoUpdate.autoRestart).toBe(false);
  });

  it("should default AUTO_UPDATE_NOTIFY to true", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    const config = loadConfig();
    expect(config.autoUpdate.notify).toBe(true);
  });

  it("should default AUTO_UPDATE_AUTO_RESTART to true", () => {
    process.env["UNITY_PROJECT_PATH"] = "/tmp/test-project";
    process.env["ANTHROPIC_API_KEY"] = "sk-test-key";
    const config = loadConfig();
    expect(config.autoUpdate.autoRestart).toBe(true);
  });
});
