import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable, Writable } from "node:stream";

describe("TerminalWizard", () => {
  let outputData: string;

  beforeEach(() => {
    outputData = "";
  });

  describe("validateUnityPath", () => {
    it("should reject empty path", async () => {
      const { validateUnityPath } = await import("../../core/terminal-wizard.js");
      const result = validateUnityPath("");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("cannot be empty");
    });

    it("should reject relative path", async () => {
      const { validateUnityPath } = await import("../../core/terminal-wizard.js");
      const result = validateUnityPath("relative/path");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("absolute");
    });

    it("should reject non-existent path", async () => {
      const { validateUnityPath } = await import("../../core/terminal-wizard.js");
      const result = validateUnityPath(
        process.platform === "win32"
          ? "Z:\\this\\path\\does\\not\\exist\\hopefully"
          : "/this/path/does/not/exist/hopefully",
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain("does not exist");
    });

    it("should accept valid absolute path inside home directory", async () => {
      const os = await import("node:os");
      const homedir = os.homedir();
      const { validateUnityPath } = await import("../../core/terminal-wizard.js");
      const result = validateUnityPath(homedir);
      expect(result.valid).toBe(true);
    });

    it("should accept valid absolute path outside home directory", async () => {
      const { validateUnityPath } = await import("../../core/terminal-wizard.js");
      const outsideHome = process.platform === "win32" ? "C:\\Windows" : "/tmp";
      const result = validateUnityPath(outsideHome);
      expect(result.valid).toBe(true);
    });
  });

  describe("sanitizeEnvValue", () => {
    it("should strip newlines and carriage returns", async () => {
      const { sanitizeEnvValue } = await import("../../core/terminal-wizard.js");
      expect(sanitizeEnvValue("hello\nworld\r")).toBe("helloworld");
    });

    it("should trim whitespace", async () => {
      const { sanitizeEnvValue } = await import("../../core/terminal-wizard.js");
      expect(sanitizeEnvValue("  value  ")).toBe("value");
    });
  });

  describe("generateEnvContent", () => {
    it("should generate valid .env content with required fields", async () => {
      const { generateEnvContent } = await import("../../core/terminal-wizard.js");
      const content = generateEnvContent({
        unityProjectPath: "/Users/test/MyGame",
        apiKey: "sk-test-123",
        provider: "claude",
        channel: "web",
        language: "en",
      });
      expect(content).toContain('UNITY_PROJECT_PATH="/Users/test/MyGame"');
      expect(content).toContain('ANTHROPIC_API_KEY="sk-test-123"');
      expect(content).toContain("DEFAULT_CHANNEL=web");
      expect(content).toContain("LANGUAGE_PREFERENCE=en");
      expect(content).toContain("STREAMING_ENABLED=true");
      expect(content).toContain("MULTI_AGENT_ENABLED=true");
      expect(content).toContain("TASK_DELEGATION_ENABLED=true");
    });

    it("should detect OpenAI key format", async () => {
      const { generateEnvContent } = await import("../../core/terminal-wizard.js");
      const content = generateEnvContent({
        unityProjectPath: "/Users/test/MyGame",
        apiKey: "sk-proj-abc123",
        provider: "openai",
        channel: "web",
        language: "en",
      });
      expect(content).toContain('OPENAI_API_KEY="sk-proj-abc123"');
    });

    it("should detect Gemini key format", async () => {
      const { generateEnvContent } = await import("../../core/terminal-wizard.js");
      const content = generateEnvContent({
        unityProjectPath: "/Users/test/MyGame",
        apiKey: "AIza-test",
        provider: "gemini",
        channel: "web",
        language: "en",
      });
      expect(content).toContain('GEMINI_API_KEY="AIza-test"');
    });

    it("should support additional response providers such as DeepSeek", async () => {
      const { generateEnvContent } = await import("../../core/terminal-wizard.js");
      const content = generateEnvContent({
        unityProjectPath: "/Users/test/MyGame",
        apiKey: "sk-deepseek-test",
        provider: "deepseek",
        channel: "cli",
        language: "en",
      });
      expect(content).toContain('DEEPSEEK_API_KEY="sk-deepseek-test"');
      expect(content).toContain("PROVIDER_CHAIN=deepseek");
    });

    it("should support keyless Ollama response workers", async () => {
      const { generateEnvContent } = await import("../../core/terminal-wizard.js");
      const content = generateEnvContent({
        unityProjectPath: "/Users/test/MyGame",
        provider: "ollama",
        embeddingProvider: "ollama",
        channel: "cli",
        language: "en",
      });
      expect(content).toContain("PROVIDER_CHAIN=ollama");
      expect(content).not.toContain("OLLAMA_API_KEY");
    });
  });

  describe("detectProvider", () => {
    it("should detect Claude from sk-ant- prefix", async () => {
      const { detectProvider } = await import("../../core/terminal-wizard.js");
      expect(detectProvider("sk-ant-api03-test")).toBe("claude");
    });

    it("should detect OpenAI from sk-proj- prefix", async () => {
      const { detectProvider } = await import("../../core/terminal-wizard.js");
      expect(detectProvider("sk-proj-abc")).toBe("openai");
    });

    it("should detect Gemini from AIza prefix", async () => {
      const { detectProvider } = await import("../../core/terminal-wizard.js");
      expect(detectProvider("AIzaSy-test")).toBe("gemini");
    });

    it("should default to claude for unknown format", async () => {
      const { detectProvider } = await import("../../core/terminal-wizard.js");
      expect(detectProvider("unknown-key")).toBe("claude");
    });
  });
});
