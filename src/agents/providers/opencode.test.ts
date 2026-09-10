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

  it("OPENCODE_CONTEXT_WINDOW sets the window compaction plans against; below 8192 or unset means 128k (measured 2026-09-09: the free tier hung at 57k)", async () => {
    const before = process.env["OPENCODE_CONTEXT_WINDOW"];
    try {
      process.env["OPENCODE_CONTEXT_WINDOW"] = "64000";
      vi.resetModules();
      const mod = await import("./opencode.js");
      expect(mod.OPENCODE_CONTEXT_WINDOW).toBe(64_000);
      expect(new mod.OpencodeProvider({ apiKey: "k" } as never).capabilities.contextWindow).toBe(64_000);
      process.env["OPENCODE_CONTEXT_WINDOW"] = "100";
      vi.resetModules();
      expect((await import("./opencode.js")).OPENCODE_CONTEXT_WINDOW).toBe(128_000);
      delete process.env["OPENCODE_CONTEXT_WINDOW"];
      vi.resetModules();
      expect((await import("./opencode.js")).OPENCODE_CONTEXT_WINDOW).toBe(128_000);
    } finally {
      if (before === undefined) delete process.env["OPENCODE_CONTEXT_WINDOW"]; else process.env["OPENCODE_CONTEXT_WINDOW"] = before;
      vi.resetModules();
    }
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

describe("reasoning_content is passed back on tool-call turns (measured 2026-09-10: DeepSeek V4.1 thinking mode returns 400 without it)", () => {
  const build = (msg: Record<string, unknown>) =>
    (new OpencodeProvider("sk-test") as unknown as {
      buildMessages(system: string, messages: unknown[]): Array<Record<string, unknown>>;
    }).buildMessages("sys", [msg])[1]!;
  const toolCall = (providerMetadata?: Record<string, unknown>) => ({
    id: "call_1",
    name: "file_read",
    input: { path: "Assets/Foo.cs" },
    ...(providerMetadata ? { providerMetadata } : {}),
  });

  it("uses the reasoning the response carried in providerMetadata", () => {
    const m = build({ role: "assistant", content: "Reading.", tool_calls: [toolCall({ reasoning_content: "I should read it." })] });
    expect(m["reasoning_content"]).toBe("I should read it.");
    expect(m["tool_calls"]).toHaveLength(1);
  });

  it("falls back to the <reasoning> block embedded in the text", () => {
    const m = build({ role: "assistant", content: "<reasoning>\nthink hard\n</reasoning>\n\nReading.", tool_calls: [toolCall()] });
    expect(m["reasoning_content"]).toBe("think hard");
  });

  it("never sends a tool-call turn without the field", () => {
    const m = build({ role: "assistant", content: null, tool_calls: [toolCall()] });
    expect(typeof m["reasoning_content"]).toBe("string");
    expect((m["reasoning_content"] as string).length).toBeGreaterThan(0);
  });

  it("a plain assistant turn without tool calls is untouched", () => {
    const m = build({ role: "assistant", content: "Done." });
    expect(m["reasoning_content"]).toBeUndefined();
  });
});


describe("every assistant tool_call is answered on replay (measured 2026-09-10 15:33: 400 'insufficient tool messages following tool_calls message')", () => {
  const build = (messages: unknown[]) =>
    (new OpencodeProvider("sk-test") as unknown as {
      buildMessages(system: string, messages: unknown[]): Array<Record<string, unknown>>;
    }).buildMessages("sys", messages);

  it("fills a dangling tool call with a tool message that says no result was recorded", () => {
    const out = build([
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [
        { id: "call_a", name: "file_read", input: { path: "a" } },
        { id: "call_b", name: "file_read", input: { path: "b" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: "A" }] },
      { role: "assistant", content: "next" },
    ]);
    const roles = out.map((m) => `${m["role"]}${m["tool_call_id"] ? ":" + m["tool_call_id"] : ""}`);
    expect(roles).toEqual(["system", "user", "assistant", "tool:call_a", "tool:call_b", "assistant"]);
    expect(String(out[4]!["content"])).toContain("no result was recorded");
  });

  it("leaves a fully answered turn exactly as it was", () => {
    const out = build([
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_a", name: "file_read", input: { path: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: "A" }] },
    ]);
    expect(out.map((m) => m["role"])).toEqual(["system", "user", "assistant", "tool"]);
  });
});
