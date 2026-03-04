import { describe, it, expect, vi } from "vitest";
import { KimiProvider } from "./kimi.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("KimiProvider", () => {
  it("has correct name and capabilities", () => {
    const provider = new KimiProvider("test-key");
    expect(provider.name).toBe("Kimi (Moonshot)");
    expect(provider.capabilities.maxTokens).toBe(8192);
    expect(provider.capabilities.vision).toBe(true);
    expect(provider.capabilities.toolCalling).toBe(true);
    expect(provider.capabilities.systemPrompt).toBe(true);
  });

  it("uses default model and base URL", () => {
    const provider = new KimiProvider("test-key");
    // Verify it was created (constructor ran without error)
    expect(provider.name).toBe("Kimi (Moonshot)");
  });

  it("accepts custom model and base URL", () => {
    const provider = new KimiProvider(
      "test-key",
      "kimi-k2.5",
      "https://api.moonshot.ai/v1",
    );
    expect(provider.name).toBe("Kimi (Moonshot)");
  });

  it("inherits parseResponse from OpenAIProvider", () => {
    const provider = new KimiProvider("test-key");
    const parse = (data: unknown) =>
      (provider as unknown as { parseResponse: (d: unknown) => unknown }).parseResponse(data);

    const data = {
      choices: [{
        message: { content: "Hello from Kimi" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const result = parse(data) as { text: string; stopReason: string };
    expect(result.text).toBe("Hello from Kimi");
    expect(result.stopReason).toBe("end_turn");
  });
});
