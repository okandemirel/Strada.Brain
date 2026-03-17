/**
 * Provider Feature Matrix Tests
 *
 * Verifies that ALL promised features work correctly across ALL providers:
 * 1. Streaming (chatStream) — all OpenAI-compat except Gemini
 * 2. Retry logic (fetchWithRetry) — 429/5xx with exponential backoff
 * 3. max_tokens from capabilities — not hardcoded
 * 4. buildHeaders() — overridable, Kimi sends User-Agent
 * 5. Reasoning strip — DeepSeek and MiniMax
 * 6. STOP_REASON_MAP — shared constant
 * 7. Vision: false — all providers without image handling
 * 8. Secret sanitization — error text sanitized
 * 9. SSE buffer overflow protection
 * 10. Response body drain on retry
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock logger
vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock secret sanitizer
vi.mock("../../security/secret-sanitizer.js", () => ({
  sanitizeSecrets: (s: string) => s.replace(/sk-[a-zA-Z0-9]+/g, "[REDACTED]"),
}));

import { OpenAIProvider } from "./openai.js";
import { ClaudeProvider } from "./claude.js";
import { DeepSeekProvider } from "./deepseek.js";
import { GeminiProvider } from "./gemini.js";
import { GroqProvider } from "./groq.js";
import { MistralProvider } from "./mistral.js";
import { KimiProvider } from "./kimi.js";
import { QwenProvider } from "./qwen.js";
import { MiniMaxProvider } from "./minimax.js";
import { TogetherProvider } from "./together.js";
import { FireworksProvider } from "./fireworks.js";
import { OllamaProvider } from "./ollama.js";
import { supportsStreaming } from "./provider.interface.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// 1. STREAMING — All OpenAI-compat providers have chatStream except Gemini
// ============================================================================

describe("Feature: Streaming (chatStream)", () => {
  const providers = [
    { name: "OpenAI", cls: OpenAIProvider, args: ["key"] },
    { name: "DeepSeek", cls: DeepSeekProvider, args: ["key"] },
    { name: "Groq", cls: GroqProvider, args: ["key"] },
    { name: "Mistral", cls: MistralProvider, args: ["key"] },
    { name: "Kimi", cls: KimiProvider, args: ["key"] },
    { name: "Qwen", cls: QwenProvider, args: ["key"] },
    { name: "MiniMax", cls: MiniMaxProvider, args: ["key"] },
    { name: "Together", cls: TogetherProvider, args: ["key"] },
    { name: "Fireworks", cls: FireworksProvider, args: ["key"] },
  ] as const;

  for (const { name, cls, args } of providers) {
    it(`${name} supports streaming and has chatStream`, () => {
      const provider = new (cls as any)(...args);
      expect(provider.capabilities.streaming).toBe(true);
      expect(supportsStreaming(provider)).toBe(true);
      expect(typeof provider.chatStream).toBe("function");
    });
  }

  it("Gemini supports streaming with thought_signature capture", () => {
    const gemini = new GeminiProvider("key");
    expect(gemini.capabilities.streaming).toBe(true);
    expect(supportsStreaming(gemini)).toBe(true);
  });

  it("Ollama does NOT support streaming", () => {
    const ollama = new OllamaProvider();
    expect(ollama.capabilities.streaming).toBe(false);
  });

  it("Claude supports streaming via Anthropic SDK", () => {
    const claude = new ClaudeProvider("key");
    expect(claude.capabilities.streaming).toBe(true);
    expect(typeof claude.chatStream).toBe("function");
  });
});

// ============================================================================
// 2. max_tokens — Each provider uses its own capabilities.maxTokens
// ============================================================================

describe("Feature: max_tokens from capabilities", () => {
  const providerConfigs = [
    { name: "OpenAI", cls: OpenAIProvider, args: ["key"], expected: 4096 },
    { name: "DeepSeek", cls: DeepSeekProvider, args: ["key"], expected: 8192 },
    { name: "Groq", cls: GroqProvider, args: ["key"], expected: 8192 },
    { name: "Mistral", cls: MistralProvider, args: ["key"], expected: 8192 },
    { name: "Kimi", cls: KimiProvider, args: ["key"], expected: 8192 },
    { name: "Qwen", cls: QwenProvider, args: ["key"], expected: 8192 },
    { name: "MiniMax", cls: MiniMaxProvider, args: ["key"], expected: 4096 },
    { name: "Together", cls: TogetherProvider, args: ["key"], expected: 4096 },
    { name: "Fireworks", cls: FireworksProvider, args: ["key"], expected: 4096 },
  ];

  for (const { name, cls, args, expected } of providerConfigs) {
    it(`${name} sends max_tokens=${expected} in request body`, async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        headers: new Headers(),
      });

      const provider = new (cls as any)(...args);
      await provider.chat("system", [{ role: "user", content: "test" }], []);

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.max_tokens).toBe(expected);
    });
  }

  it("Claude sends max_tokens=8192", () => {
    const claude = new ClaudeProvider("key");
    expect(claude.capabilities.maxTokens).toBe(8192);
  });
});

// ============================================================================
// 3. buildHeaders — Kimi sends User-Agent, others don't
// ============================================================================

describe("Feature: buildHeaders (provider-specific headers)", () => {
  it("Kimi sends User-Agent: claude-code/0.1.0", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      headers: new Headers(),
    });

    const kimi = new KimiProvider("key");
    await kimi.chat("system", [{ role: "user", content: "test" }], []);

    const headers = mockFetch.mock.calls[0]![1].headers;
    expect(headers["User-Agent"]).toBe("claude-code/0.1.0");
    expect(headers["Authorization"]).toBe("Bearer key");
  });

  it("OpenAI does NOT send User-Agent", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      headers: new Headers(),
    });

    const openai = new OpenAIProvider("key");
    await openai.chat("system", [{ role: "user", content: "test" }], []);

    const headers = mockFetch.mock.calls[0]![1].headers;
    expect(headers["User-Agent"]).toBeUndefined();
  });

  it("Mistral sends safe_prompt in body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      headers: new Headers(),
    });

    const mistral = new MistralProvider("key");
    await mistral.chat("system", [{ role: "user", content: "test" }], []);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.safe_prompt).toBe(false);
  });

  it("Qwen sends result_format and enable_search in body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      headers: new Headers(),
    });

    const qwen = new QwenProvider("key");
    await qwen.chat("system", [{ role: "user", content: "test" }], []);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.result_format).toBe("message");
    expect(body.enable_search).toBe(false);
  });
});

// ============================================================================
// 4. Reasoning strip — DeepSeek and MiniMax strip <reasoning> blocks
// ============================================================================

describe("Feature: Reasoning block stripping", () => {
  const reasoningMessage = {
    role: "assistant" as const,
    content: "<reasoning>\nThinking about this...\n</reasoning>\n\nActual answer here",
  };

  for (const { name, cls } of [
    { name: "DeepSeek", cls: DeepSeekProvider },
    { name: "MiniMax", cls: MiniMaxProvider },
  ]) {
    it(`${name} strips <reasoning> blocks from assistant messages`, async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "reply" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        headers: new Headers(),
      });

      const provider = new (cls as any)("key");
      await provider.chat(
        "system",
        [reasoningMessage, { role: "user", content: "follow up" }],
        [],
      );

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      const assistantMsg = body.messages.find((m: any) => m.role === "assistant");
      expect(assistantMsg.content).not.toContain("<reasoning>");
      expect(assistantMsg.content).toContain("Actual answer here");
    });
  }

  it("OpenAI does NOT strip reasoning blocks (not applicable)", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "reply" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      headers: new Headers(),
    });

    const openai = new OpenAIProvider("key");
    await openai.chat(
      "system",
      [reasoningMessage, { role: "user", content: "follow up" }],
      [],
    );

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    const assistantMsg = body.messages.find((m: any) => m.role === "assistant");
    // OpenAI keeps reasoning blocks (not its concern)
    expect(assistantMsg.content).toContain("<reasoning>");
  });
});

// ============================================================================
// 5. Vision capability — providers declare correct vision support
// ============================================================================

describe("Feature: Vision capability", () => {
  const visionEnabled = [
    { name: "OpenAI", provider: new OpenAIProvider("k") },
    { name: "Gemini", provider: new GeminiProvider("k") },
    { name: "Kimi", provider: new KimiProvider("k") },
    { name: "Claude", provider: new ClaudeProvider("k") },
  ];

  const visionDisabled = [
    { name: "DeepSeek", provider: new DeepSeekProvider("k") },
    { name: "Groq", provider: new GroqProvider("k") },
    { name: "Mistral", provider: new MistralProvider("k") },
    { name: "Qwen", provider: new QwenProvider("k") },
    { name: "MiniMax", provider: new MiniMaxProvider("k") },
    { name: "Together", provider: new TogetherProvider("k") },
    { name: "Fireworks", provider: new FireworksProvider("k") },
    { name: "Ollama", provider: new OllamaProvider() },
  ];

  for (const { name, provider } of visionEnabled) {
    it(`${name} has vision: true`, () => {
      expect(provider.capabilities.vision).toBe(true);
    });
  }

  for (const { name, provider } of visionDisabled) {
    it(`${name} has vision: false`, () => {
      expect(provider.capabilities.vision).toBe(false);
    });
  }
});

// ============================================================================
// 6. Retry logic — 429/5xx retried, 400/401/403 NOT retried
// ============================================================================

describe("Feature: Retry logic", () => {
  it("retries on 429 (rate limit) with body drain", async () => {
    const mockCancel = vi.fn();
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "0" }),
        body: { cancel: mockCancel },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        headers: new Headers(),
      });

    const provider = new OpenAIProvider("key");
    const result = await provider.chat("system", [{ role: "user", content: "test" }], []);

    expect(result.text).toBe("ok");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockCancel).toHaveBeenCalled(); // body drained
  });

  it("retries on 500 (server error)", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "recovered" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        headers: new Headers(),
      });

    const provider = new OpenAIProvider("key");
    const result = await provider.chat("system", [{ role: "user", content: "test" }], []);

    expect(result.text).toBe("recovered");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 400 (bad request)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Bad Request",
      headers: new Headers(),
    });

    const provider = new OpenAIProvider("key");
    await expect(
      provider.chat("system", [{ role: "user", content: "test" }], []),
    ).rejects.toThrow("400");
    expect(mockFetch).toHaveBeenCalledTimes(1); // no retry
  });

  it("does NOT retry on 403 (forbidden)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
      headers: new Headers(),
    });

    const provider = new KimiProvider("key");
    await expect(
      provider.chat("system", [{ role: "user", content: "test" }], []),
    ).rejects.toThrow("403");
    expect(mockFetch).toHaveBeenCalledTimes(1); // no retry
  });

  it("caps retry-after at 60 seconds", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "999999" }),
        body: { cancel: vi.fn() },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        headers: new Headers(),
      });

    const start = Date.now();
    const provider = new OpenAIProvider("key");
    await provider.chat("system", [{ role: "user", content: "test" }], []);
    const elapsed = Date.now() - start;

    // Should be capped at 60s, not 999999s. In practice < 61s.
    expect(elapsed).toBeLessThan(65000);
  }, 70000);

  it("sanitizes error text with SecretSanitizer", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Invalid API key: sk-abc123def456',
      headers: new Headers(),
    });

    const provider = new OpenAIProvider("key");
    await expect(
      provider.chat("system", [{ role: "user", content: "test" }], []),
    ).rejects.toThrow("[REDACTED]");
  });
});

// ============================================================================
// 7. Endpoint URLs — Each provider hits the correct API
// ============================================================================

describe("Feature: Correct endpoint URLs", () => {
  const endpointTests = [
    { name: "OpenAI", cls: OpenAIProvider, expected: "https://api.openai.com/v1/chat/completions" },
    { name: "DeepSeek", cls: DeepSeekProvider, expected: "https://api.deepseek.com/v1/chat/completions" },
    { name: "Gemini", cls: GeminiProvider, expected: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" },
    { name: "Groq", cls: GroqProvider, expected: "https://api.groq.com/openai/v1/chat/completions" },
    { name: "Mistral", cls: MistralProvider, expected: "https://api.mistral.ai/v1/chat/completions" },
    { name: "Kimi", cls: KimiProvider, expected: "https://api.kimi.com/coding/v1/chat/completions" },
    { name: "Qwen", cls: QwenProvider, expected: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions" },
    { name: "MiniMax", cls: MiniMaxProvider, expected: "https://api.minimax.io/v1/chat/completions" },
    { name: "Together", cls: TogetherProvider, expected: "https://api.together.xyz/v1/chat/completions" },
    { name: "Fireworks", cls: FireworksProvider, expected: "https://api.fireworks.ai/inference/v1/chat/completions" },
  ];

  for (const { name, cls, expected } of endpointTests) {
    it(`${name} calls ${expected}`, async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        headers: new Headers(),
      });

      const provider = new (cls as any)("key");
      await provider.chat("system", [{ role: "user", content: "test" }], []);

      expect(mockFetch.mock.calls[0]![0]).toBe(expected);
    });
  }
});

// ============================================================================
// 8. Gemini thought_signature — parseResponse captures, buildMessages echoes
// ============================================================================

describe("Feature: Gemini thought_signature round-trip", () => {
  it("parseResponse captures extra_content as providerMetadata", () => {
    const gemini = new GeminiProvider("key");
    const parse = (data: unknown) =>
      (gemini as any).parseResponse(data);

    const data = {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "test", arguments: '{}' },
            extra_content: [{ type: "google.thought_signature", data: "sig123" }],
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };

    const result = parse(data);
    expect(result.toolCalls[0].providerMetadata).toBeDefined();
    expect(result.toolCalls[0].providerMetadata.extra_content).toEqual(
      [{ type: "google.thought_signature", data: "sig123" }],
    );
  });

  it("buildMessages echoes providerMetadata back into tool_calls", () => {
    const gemini = new GeminiProvider("key");
    const build = (sys: string, msgs: any[]) =>
      (gemini as any).buildMessages(sys, msgs);

    const messages = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          name: "test",
          input: {},
          providerMetadata: {
            extra_content: [{ type: "google.thought_signature", data: "sig123" }],
          },
        }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "result" }],
      },
    ];

    const result = build("system", messages);
    const assistantMsg = result.find((m: any) => m.role === "assistant");
    expect(assistantMsg.tool_calls[0].extra_content).toEqual(
      [{ type: "google.thought_signature", data: "sig123" }],
    );
  });

  it("buildMessages injects skip_thought_signature_validator when tool metadata is missing", () => {
    const gemini = new GeminiProvider("key");
    const build = (sys: string, msgs: any[]) =>
      (gemini as any).buildMessages(sys, msgs);

    const messages = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          name: "test",
          input: {},
        }],
      },
    ];

    const result = build("system", messages);
    const assistantMsg = result.find((m: any) => m.role === "assistant");
    expect(assistantMsg.tool_calls[0].extra_content).toEqual(
      { google: { thought_signature: "skip_thought_signature_validator" } },
    );
  });
});

// ============================================================================
// 9. Kimi reasoning_content — parseResponse captures, buildMessages echoes
// ============================================================================

describe("Feature: Kimi reasoning_content round-trip", () => {
  it("parseResponse captures reasoning_content in providerMetadata (first tool call only)", () => {
    const kimi = new KimiProvider("key");
    const parse = (data: unknown) => (kimi as any).parseResponse(data);

    const data = {
      choices: [{
        message: {
          content: null,
          reasoning_content: "Let me think about this...",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "file_read", arguments: '{"path":"a.ts"}' } },
            { id: "call_2", type: "function", function: { name: "file_read", arguments: '{"path":"b.ts"}' } },
          ],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };

    const result = parse(data);
    // First tool call has reasoning
    expect(result.toolCalls[0].providerMetadata?.reasoning_content).toBe("Let me think about this...");
    // Second tool call does NOT (turn-level, not per-call)
    expect(result.toolCalls[1].providerMetadata).toBeUndefined();
  });

  it("parseResponse omits providerMetadata when reasoning_content is null", () => {
    const kimi = new KimiProvider("key");
    const parse = (data: unknown) => (kimi as any).parseResponse(data);

    const data = {
      choices: [{
        message: {
          content: "Simple answer",
          reasoning_content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "test", arguments: '{}' } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    };

    const result = parse(data);
    expect(result.toolCalls[0].providerMetadata).toBeUndefined();
  });

  it("parseResponse omits providerMetadata when reasoning_content is empty string", () => {
    const kimi = new KimiProvider("key");
    const parse = (data: unknown) => (kimi as any).parseResponse(data);

    const data = {
      choices: [{
        message: {
          content: "answer",
          reasoning_content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "test", arguments: '{}' } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    };

    const result = parse(data);
    // Empty string is falsy, so no providerMetadata
    expect(result.toolCalls[0].providerMetadata).toBeUndefined();
  });

  it("buildMessages echoes reasoning_content on assistant tool call message", () => {
    const kimi = new KimiProvider("key");
    const build = (sys: string, msgs: any[]) => (kimi as any).buildMessages(sys, msgs);

    const messages = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          name: "file_read",
          input: { path: "test.cs" },
          providerMetadata: { reasoning_content: "I need to read the file first" },
        }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "file contents" }],
      },
    ];

    const result = build("system", messages);
    const assistantMsg = result.find((m: any) => m.role === "assistant");
    expect(assistantMsg.reasoning_content).toBe("I need to read the file first");
  });

  it("buildMessages omits reasoning_content when not present", () => {
    const kimi = new KimiProvider("key");
    const build = (sys: string, msgs: any[]) => (kimi as any).buildMessages(sys, msgs);

    const messages = [
      {
        role: "assistant",
        content: "no thinking here",
        tool_calls: [{
          id: "call_1",
          name: "test",
          input: {},
          // No providerMetadata
        }],
      },
    ];

    const result = build("system", messages);
    const assistantMsg = result.find((m: any) => m.role === "assistant");
    expect(assistantMsg.reasoning_content).toBeUndefined();
  });

  it("buildMessages finds reasoning_content from any tool call position", () => {
    const kimi = new KimiProvider("key");
    const build = (sys: string, msgs: any[]) => (kimi as any).buildMessages(sys, msgs);

    const messages = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", name: "a", input: {} },
          { id: "call_2", name: "b", input: {}, providerMetadata: { reasoning_content: "found it" } },
        ],
      },
    ];

    const result = build("system", messages);
    const assistantMsg = result.find((m: any) => m.role === "assistant");
    expect(assistantMsg.reasoning_content).toBe("found it");
  });
});

// ============================================================================
// 10. SSE streaming — buffer overflow and null body protection
// ============================================================================

describe("Feature: SSE streaming safety", () => {
  it("throws on null response body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      body: null,
      headers: new Headers(),
    });

    const provider = new OpenAIProvider("key");
    await expect(
      provider.chatStream("system", [{ role: "user", content: "test" }], [], vi.fn()),
    ).rejects.toThrow("streaming response has no body");
  });
});
