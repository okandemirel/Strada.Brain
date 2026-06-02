import { describe, it, expect, vi } from "vitest";
import { OpenRouterProvider } from "./openrouter.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("OpenRouterProvider", () => {
  it("has correct name and capabilities", () => {
    const provider = new OpenRouterProvider("test-key");
    expect(provider.name).toBe("OpenRouter");
    expect(provider.capabilities.maxTokens).toBe(8192);
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.toolCalling).toBe(true);
    expect(provider.capabilities.vision).toBe(true);
    expect(provider.capabilities.systemPrompt).toBe(true);
    expect(provider.capabilities.contextWindow).toBe(128_000);
  });

  it("uses default model and base URL", () => {
    const provider = new OpenRouterProvider("test-key");
    expect(provider.name).toBe("OpenRouter");
  });

  it("accepts custom model and base URL", () => {
    const provider = new OpenRouterProvider(
      "test-key",
      "anthropic/claude-sonnet-4",
      "https://custom.openrouter.ai/v1",
    );
    expect(provider.name).toBe("OpenRouter");
  });

  describe("buildHeaders", () => {
    it("includes ranking headers and bearer auth", async () => {
      const provider = new OpenRouterProvider("test-key");
      const headers = await (provider as unknown as { buildHeaders: () => Promise<Record<string, string>> }).buildHeaders();
      expect(headers["HTTP-Referer"]).toBe("https://github.com/okandemirel/Strada.Brain");
      expect(headers["X-Title"]).toBe("Strada.Brain");
      expect(headers["Authorization"]).toBe("Bearer test-key");
    });
  });
});
