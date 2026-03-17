import { describe, expect, it } from "vitest";
import { generateEnvContent } from "./terminal-wizard.js";

describe("generateEnvContent", () => {
  it("uses EMBEDDING_PROVIDER for Gemini and aligns dashboard port defaults", () => {
    const content = generateEnvContent({
      unityProjectPath: "/Users/test/MyGame",
      apiKey: "AIza-test-key",
      provider: "gemini",
      channel: "web",
      language: "en",
    });

    expect(content).toContain("EMBEDDING_PROVIDER=gemini");
    expect(content).not.toContain("RAG_EMBEDDING_PROVIDER=gemini");
    expect(content).toContain("DASHBOARD_PORT=3100");
  });
});
