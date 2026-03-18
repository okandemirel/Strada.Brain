import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  validateUnityPath,
  sanitizeEnvValue,
  generateEnvContent,
  detectProvider,
} from "../../core/terminal-wizard.js";

describe("Terminal Wizard Integration", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true }); } catch {}
    }
    tmpDirs.length = 0;
  });

  it("should generate valid .env and write it to disk", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "strada-wizard-"));
    tmpDirs.push(tmpDir);
    const content = generateEnvContent({
      unityProjectPath: os.homedir(),
      apiKey: "sk-ant-test-key",
      provider: "claude",
      channel: "web",
      language: "tr",
    });
    const envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(envPath, content, "utf-8");
    const written = fs.readFileSync(envPath, "utf-8");
    expect(written).toContain("UNITY_PROJECT_PATH=");
    expect(written).toContain('ANTHROPIC_API_KEY="sk-ant-test-key"');
    expect(written).toContain("LANGUAGE_PREFERENCE=tr");
    expect(written).toContain("STREAMING_ENABLED=true");
  });

  it("should generate config for non-default response providers", () => {
    const content = generateEnvContent({
      unityProjectPath: os.homedir(),
      apiKey: "sk-deepseek-test-key",
      provider: "deepseek",
      channel: "cli",
      language: "en",
    });

    expect(content).toContain('DEEPSEEK_API_KEY="sk-deepseek-test-key"');
    expect(content).toContain("PROVIDER_CHAIN=deepseek");
  });

  it("should detect all provider types correctly", () => {
    expect(detectProvider("sk-ant-api03-test")).toBe("claude");
    expect(detectProvider("sk-proj-abc123")).toBe("openai");
    expect(detectProvider("AIzaSy-test")).toBe("gemini");
    expect(detectProvider("unknown-key")).toBe("claude");
  });

  it("should sanitize env values for injection prevention", () => {
    expect(sanitizeEnvValue("value\nINJECTED=true")).toBe("valueINJECTED=true");
    expect(sanitizeEnvValue("value\r\nATTACK=1")).toBe("valueATTACK=1");
    expect(sanitizeEnvValue("  padded  ")).toBe("padded");
  });

  it("should validate unity path security constraints", () => {
    expect(validateUnityPath("").valid).toBe(false);
    expect(validateUnityPath("./relative").valid).toBe(false);
    expect(validateUnityPath("/etc/shadow").valid).toBe(false);
    expect(validateUnityPath(os.homedir()).valid).toBe(true);
  });
});
