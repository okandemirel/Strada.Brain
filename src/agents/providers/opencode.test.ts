import { describe, it, expect, vi } from "vitest";
import { OpencodeProvider } from "./opencode.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("OpencodeProvider", () => {
  it("has correct name and capabilities", () => {
    const provider = new OpencodeProvider("test-key");
    expect(provider.name).toBe("OpenCode (Zen/Go)");
    expect(provider.capabilities.maxTokens).toBe(8192);
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.toolCalling).toBe(true);
    expect(provider.capabilities.vision).toBe(true);
    expect(provider.capabilities.systemPrompt).toBe(true);
    expect(provider.capabilities.contextWindow).toBe(128_000);
  });

  it("uses default model and base URL", () => {
    const provider = new OpencodeProvider("test-key");
    expect(provider.name).toBe("OpenCode (Zen/Go)");
  });

  it("accepts custom model and base URL", () => {
    const provider = new OpencodeProvider(
      "test-key",
      "opencode/gpt-5.5",
      "https://custom.opencode.ai/v1",
    );
    expect(provider.name).toBe("OpenCode (Zen/Go)");
  });

  describe("buildHeaders", () => {
    it("includes User-Agent header", async () => {
      const provider = new OpencodeProvider("test-key");
      const headers = await (provider as unknown as { buildHeaders: () => Promise<Record<string, string>> }).buildHeaders();
      expect(headers["User-Agent"]).toBe("Strada.Brain/1.0");
      expect(headers["Authorization"]).toBe("Bearer test-key");
    });
  });
});
