import { describe, expect, it } from "vitest";
import { generateEnvContent } from "./terminal-wizard.js";

describe("generateEnvContent", () => {
  it("uses EMBEDDING_PROVIDER for Gemini and aligns dashboard port defaults", () => {
    const content = generateEnvContent({
      unityProjectPath: "/Users/test/MyGame",
      apiKey: "AIza-test-key",
      provider: "gemini",
      embeddingProvider: "gemini",
      channel: "web",
      language: "en",
    });

    expect(content).toContain("EMBEDDING_PROVIDER=gemini");
    expect(content).not.toContain("RAG_EMBEDDING_PROVIDER=gemini");
    expect(content).toContain("DASHBOARD_PORT=3100");
  });

  it("supports a dedicated embedding provider key independent from the response chain", () => {
    const content = generateEnvContent({
      unityProjectPath: "/Users/test/MyGame",
      apiKey: "sk-proj-openai-key",
      provider: "openai",
      embeddingProvider: "gemini",
      embeddingApiKey: "AIza-gemini-key",
      channel: "web",
      language: "en",
    });

    expect(content).toContain('OPENAI_API_KEY="sk-proj-openai-key"');
    expect(content).toContain("PROVIDER_CHAIN=openai");
    expect(content).toContain('GEMINI_API_KEY="AIza-gemini-key"');
    expect(content).toContain("EMBEDDING_PROVIDER=gemini");
  });
});
