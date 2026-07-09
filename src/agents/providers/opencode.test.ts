import { describe, it, expect, vi } from "vitest";
import { OpencodeProvider } from "./opencode.js";

vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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

  // OpenCode's API rejects namespaced ids ("Model opencode/... is not supported",
  // verified live via /models which returns BARE ids). Strip the "opencode/" prefix
  // so presets / saved preferences / catalog entries all send a valid bare id.
  it("strips the 'opencode/' prefix from model ids (API expects bare ids)", () => {
    const provider = new OpencodeProvider("test-key", "opencode/deepseek-v4-flash");
    expect((provider as unknown as { model: string }).model).toBe("deepseek-v4-flash");
  });

  it("passes a bare model id through unchanged and defaults to a live bare id", () => {
    expect((new OpencodeProvider("k", "qwen3.6-plus") as unknown as { model: string }).model)
      .toBe("qwen3.6-plus");
    // Default must be a CURRENT, bare model (retired ids must not be reintroduced).
    expect((new OpencodeProvider("k") as unknown as { model: string }).model)
      .toBe("qwen3.6-plus");
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
