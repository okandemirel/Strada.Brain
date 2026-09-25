/**
 * Cross-provider call-options contract (PRV-12).
 *
 * `maxTokens` and `onBackoff` are part of ProviderCallOptions, so a caller
 * cannot tell which adapter will serve it. Several paths dropped them
 * silently: subclass `buildRequestBody` overrides took two arguments, Gemini's
 * own stream and the Codex subscription path never handed the hooks to the
 * retry wrapper, and Claude and Ollama sent a fixed cap. A dropped `onBackoff`
 * makes a 429 wait look like an unresponsive endpoint to the chain; a dropped
 * `maxTokens` makes a smaller retry after a mid-stream drop repeat the call
 * that just died.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IAIProvider } from "./provider.interface.js";

vi.mock("@anthropic-ai/sdk", () => {
  const mockCreate = vi.fn();
  const mockStream = vi.fn();
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate, stream: mockStream };
    },
    __mockCreate: mockCreate,
    __mockStream: mockStream,
  };
});

vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const sdk = (await import("@anthropic-ai/sdk")) as unknown as {
  __mockCreate: ReturnType<typeof vi.fn>;
  __mockStream: ReturnType<typeof vi.fn>;
};

const { OpenAIProvider } = await import("./openai.js");
const { DeepSeekProvider } = await import("./deepseek.js");
const { KimiProvider } = await import("./kimi.js");
const { GroqProvider } = await import("./groq.js");
const { MistralProvider } = await import("./mistral.js");
const { QwenProvider } = await import("./qwen.js");
const { MiniMaxProvider } = await import("./minimax.js");
const { TogetherProvider } = await import("./together.js");
const { FireworksProvider } = await import("./fireworks.js");
const { OpenRouterProvider } = await import("./openrouter.js");
const { OpencodeProvider } = await import("./opencode.js");
const { GeminiProvider } = await import("./gemini.js");
const { ClaudeProvider } = await import("./claude.js");
const { OllamaProvider } = await import("./ollama.js");
const { FallbackChainProvider } = await import("./fallback-chain.js");

const USER = [{ role: "user" as const, content: "hi" }];

function chatCompletionJson(): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    text: async () => "",
  } as unknown as Response;
}

function sseResponse(lines: string[]): Response {
  const encoded = new TextEncoder().encode(lines.map((l) => `${l}\n\n`).join(""));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A retryable 429 whose Retry-After keeps the test fast (1 ms). */
function rateLimited(): Response {
  return new Response("slow down", { status: 429, headers: { "retry-after": "0.001" } });
}

function sentBody(call = 0): Record<string, unknown> {
  const init = mockFetch.mock.calls[call]![1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("maxTokens reaches every OpenAI-compatible request body", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockImplementation(async () => chatCompletionJson());
  });

  // [label, the name the endpoint takes the cap under, factory]
  const table: Array<[string, string, () => IAIProvider]> = [
    ["openai (official host)", "max_completion_tokens", () => new OpenAIProvider("sk-test")],
    ["openai-compatible host", "max_tokens", () => new OpenAIProvider("sk-test", "m", "https://llm.example.test/v1")],
    ["deepseek", "max_tokens", () => new DeepSeekProvider("k")],
    ["kimi", "max_tokens", () => new KimiProvider("k")],
    ["groq", "max_tokens", () => new GroqProvider("k")],
    ["mistral", "max_tokens", () => new MistralProvider("k")],
    ["qwen", "max_tokens", () => new QwenProvider("k")],
    ["minimax", "max_tokens", () => new MiniMaxProvider("k")],
    ["together", "max_tokens", () => new TogetherProvider("k")],
    ["fireworks", "max_tokens", () => new FireworksProvider("k")],
    ["openrouter", "max_tokens", () => new OpenRouterProvider("k")],
    ["opencode", "max_tokens", () => new OpencodeProvider("k")],
    ["gemini", "max_tokens", () => new GeminiProvider("k")],
  ];

  it.each(table)("%s: chat() sends maxTokens 123 as %s", async (_label, param, make) => {
    await make().chat("sys", USER, [], { maxTokens: 123 });
    expect(sentBody()[param]).toBe(123);
  });

  it("gemini: its own chatStream sends maxTokens 123", async () => {
    mockFetch.mockImplementation(async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]));
    const provider = new GeminiProvider("k");
    const result = await provider.chatStream("sys", USER, [], () => {}, { maxTokens: 123 });
    expect(result.text).toBe("ok");
    expect(sentBody()["max_tokens"]).toBe(123);
  });

  it("the per-call cap never raises the configured one", async () => {
    await new MistralProvider("k").chat("sys", USER, [], { maxTokens: 10_000_000 });
    expect(sentBody()["max_tokens"]).toBe(8192);
  });
});

describe("maxTokens reaches the non-OpenAI adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("claude: chat() sends max_tokens 123", async () => {
    sdk.__mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await new ClaudeProvider("test-key").chat("sys", USER, [], { maxTokens: 123 });
    expect(sdk.__mockCreate.mock.calls[0]![0]).toMatchObject({ max_tokens: 123 });
  });

  it("claude: chatStream() sends max_tokens 123", async () => {
    sdk.__mockStream.mockReturnValue({
      on: vi.fn(),
      finalMessage: async () => ({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    await new ClaudeProvider("test-key").chatStream("sys", USER, [], () => {}, { maxTokens: 123 });
    expect(sdk.__mockStream.mock.calls[0]![0]).toMatchObject({ max_tokens: 123 });
  });

  it("claude: without a per-call cap the configured one is sent", async () => {
    sdk.__mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = new ClaudeProvider("test-key");
    await provider.chat("sys", USER, []);
    expect(sdk.__mockCreate.mock.calls[0]![0]).toMatchObject({ max_tokens: provider.capabilities.maxTokens });
  });

  it("ollama: chat() sends num_predict 123", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: "ok" }, prompt_eval_count: 1, eval_count: 1 }),
    });
    await new OllamaProvider().chat("sys", USER, [], { maxTokens: 123 });
    expect(sentBody()).toMatchObject({ options: { num_predict: 123 } });
  });
});

describe("onBackoff reaches the retry wrapper on every HTTP path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gemini: its own chatStream reports a 429 backoff", async () => {
    mockFetch
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(sseResponse([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
        "data: [DONE]",
      ]));
    const onBackoff = vi.fn();
    const result = await new GeminiProvider("k").chatStream("sys", USER, [], () => {}, { onBackoff });
    expect(result.text).toBe("ok");
    expect(onBackoff).toHaveBeenCalledWith(expect.objectContaining({ status: 429 }));
  });

  it("codex subscription: chat() reports a 429 backoff", async () => {
    mockFetch
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(sseResponse([
        'event: response.output_text.delta\ndata: {"delta":"ok"}',
        'event: response.completed\ndata: {"response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      ]));
    const provider = new OpenAIProvider({
      mode: "chatgpt-subscription",
      accessToken: "access-token",
      accountId: "account-id",
    });
    const onBackoff = vi.fn();
    const result = await provider.chat("sys", USER, [], { onBackoff, maxTokens: 123 });
    expect(result.text).toBe("ok");
    expect(onBackoff).toHaveBeenCalledWith(expect.objectContaining({ status: 429 }));
    // The subscription backend takes no output cap; sending one fails the call.
    expect(sentBody(1)["max_output_tokens"]).toBeUndefined();
  });

  it("the fallback chain still tells its caller about a backoff it handled", async () => {
    mockFetch
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(chatCompletionJson());
    const chain = new FallbackChainProvider([new MistralProvider("k")]);
    const onBackoff = vi.fn();
    const result = await chain.chat("sys", USER, [], { onBackoff, maxTokens: 123 });
    expect(result.text).toBe("ok");
    expect(onBackoff).toHaveBeenCalledWith(expect.objectContaining({ status: 429 }));
    expect(sentBody(1)["max_tokens"]).toBe(123);
  });
});
