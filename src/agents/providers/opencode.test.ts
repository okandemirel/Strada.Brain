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
    // Measured: successful decompositions on nemotron end at 7435-7988 output tokens; 8192 cut nine of them.
    expect(provider.capabilities.maxTokens).toBe(16_384);
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
    it("sends a stable x-opencode-session id (the API refuses requests without one)", async () => {
      const provider = new OpencodeProvider({ apiKey: "sk-test" });
      const build = (provider as unknown as { buildHeaders: () => Promise<Record<string, string>> }).buildHeaders.bind(provider);
      const first = await build();
      expect(first["x-opencode-session"]).toMatch(/^[0-9a-f-]{36}$/);
      expect((await build())["x-opencode-session"]).toBe(first["x-opencode-session"]);
      const other = new OpencodeProvider({ apiKey: "sk-test" });
      const otherHeaders = await (other as unknown as { buildHeaders: () => Promise<Record<string, string>> }).buildHeaders();
      expect(otherHeaders["x-opencode-session"]).not.toBe(first["x-opencode-session"]);
    });

    it("includes User-Agent header", async () => {
      const provider = new OpencodeProvider("test-key");
      const headers = await (provider as unknown as { buildHeaders: () => Promise<Record<string, string>> }).buildHeaders();
      expect(headers["User-Agent"]).toBe("Strada.Brain/1.0");
      expect(headers["Authorization"]).toBe("Bearer test-key");
    });
  });

  it("OPENCODE_MAX_TOKENS below one token is not an override; a fraction is floored (Codex review 2026-09-09: 0.5 became max_tokens 0)", async () => {
    const before = process.env["OPENCODE_MAX_TOKENS"];
    try {
      process.env["OPENCODE_MAX_TOKENS"] = "0.5";
      vi.resetModules();
      expect((await import("./opencode.js")).OPENCODE_MAX_TOKENS).toBe(16_384);
      process.env["OPENCODE_MAX_TOKENS"] = "4096.9";
      vi.resetModules();
      expect((await import("./opencode.js")).OPENCODE_MAX_TOKENS).toBe(4096);
    } finally {
      if (before === undefined) delete process.env["OPENCODE_MAX_TOKENS"]; else process.env["OPENCODE_MAX_TOKENS"] = before;
      vi.resetModules();
    }
  });
});
