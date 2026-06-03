import { vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAIProvider } from "./openai.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getLoggerSafe: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("OpenAIProvider", () => {
  function createJwt(expSecondsFromNow: number): string {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
    })).toString("base64url");
    return `${header}.${payload}.sig`;
  }

  it("parses a simple text response correctly", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: { content: "Hi", tool_calls: [] },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
      text: async () => "",
    });

    const provider = new OpenAIProvider("sk-test");
    const result = await provider.chat("system", [{ role: "user", content: "Hello" }], []);

    expect(result.text).toBe("Hi");
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  });

  it("parses tool call response with JSON arguments", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_abc",
                  type: "function",
                  function: {
                    name: "file_read",
                    arguments: '{"path":"Assets/test.cs"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 30 },
      }),
      text: async () => "",
    });

    const provider = new OpenAIProvider("sk-test");
    const result = await provider.chat(
      "system",
      [{ role: "user", content: "Read file" }],
      [{ name: "file_read", description: "Read a file", input_schema: { type: "object" } }],
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: "call_abc",
      name: "file_read",
      input: { path: "Assets/test.cs" },
    });
    expect(result.stopReason).toBe("tool_use");
  });

  it("falls back to _rawArguments when JSON arguments are malformed", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_bad",
                  type: "function",
                  function: {
                    name: "file_read",
                    arguments: "not valid json {{{",
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 30 },
      }),
      text: async () => "",
    });

    const provider = new OpenAIProvider("sk-test");
    const result = await provider.chat(
      "system",
      [{ role: "user", content: "Read file" }],
      [{ name: "file_read", description: "Read a file", input_schema: { type: "object" } }],
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.input).toEqual({
      _rawArguments: "not valid json {{{",
    });
  });

  it("throws an error with the status code on non-retryable API failure", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Bad Request",
      headers: new Headers(),
    });

    const provider = new OpenAIProvider("sk-test");
    await expect(provider.chat("system", [{ role: "user", content: "Hi" }], [])).rejects.toThrow(
      "OpenAI API error 400",
    );
  });

  it("retries on 429 and eventually throws after max retries", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Rate limit exceeded",
      headers: new Headers({ "retry-after": "0" }),
    });

    const provider = new OpenAIProvider("sk-test");
    await expect(provider.chat("system", [{ role: "user", content: "Hi" }], [])).rejects.toThrow(
      "OpenAI API error 429",
    );
    // Initial attempt + 3 retries = 4 calls
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("maps stop reasons: tool_calls->tool_use, length->max_tokens, stop->end_turn", async () => {
    const cases = [
      { finishReason: "tool_calls", expected: "tool_use" },
      { finishReason: "length", expected: "max_tokens" },
      { finishReason: "stop", expected: "end_turn" },
    ];

    for (const { finishReason, expected } of cases) {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: { content: "test", tool_calls: [] },
              finish_reason: finishReason,
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
        text: async () => "",
      });

      const provider = new OpenAIProvider("sk-test");
      const result = await provider.chat("system", [{ role: "user", content: "x" }], []);

      expect(result.stopReason).toBe(expected);
    }
  });

  it("does not include tools in the request body when tools array is empty", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: { content: "Hi", tool_calls: [] },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
      text: async () => "",
    });

    const provider = new OpenAIProvider("sk-test");
    await provider.chat("system", [{ role: "user", content: "Hello" }], []);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.tools).toBeUndefined();
  });

  it("supports ChatGPT/Codex subscription auth for streaming responses", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          [
            'event: response.output_text.delta',
            'data: {"delta":"pong"}',
            "",
            'event: response.completed',
            'data: {"response":{"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4},"output":[{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"pong"}]}]}}',
            "",
          ].join("\n"),
        ));
        controller.close();
      },
    });

    mockFetch.mockResolvedValue({
      ok: true,
      body: stream,
      text: async () => "",
      headers: new Headers(),
    });

    const provider = new OpenAIProvider({
      mode: "chatgpt-subscription",
      accessToken: "access-token",
      accountId: "account-id",
    });

    const result = await provider.chat("system", [{ role: "user", content: "ping" }], []);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/codex/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
          "ChatGPT-Account-Id": "account-id",
        }),
      }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "ping" }],
      },
    ]);
    expect(result.text).toBe("pong");
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1, totalTokens: 4 });
  });

  // Regression: the Codex/ChatGPT subscription backend emits `keepalive` heartbeat
  // frames (~every 30s) during long silent reasoning phases (gpt-5.x models think
  // for tens of seconds to minutes producing no output_text). These prove the
  // connection is alive and must be surfaced as stream progress (an empty onChunk)
  // so the orchestrator's stall-timeout watchdog does not abort a model that is
  // still reasoning. Without this the whole provider chain fails ("This operation
  // was aborted"). Mirrors the reasoning_content progress signal in the
  // OpenAI-compatible streaming path.
  it("treats subscription keepalive heartbeats as stream progress", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          [
            "event: keepalive",
            'data: {"type":"keepalive","sequence_number":3}',
            "",
            "event: response.output_text.delta",
            'data: {"delta":"hi"}',
            "",
            "event: response.completed",
            'data: {"response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2},"output":[{"id":"m","type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}]}}',
            "",
          ].join("\n"),
        ));
        controller.close();
      },
    });
    mockFetch.mockResolvedValue({ ok: true, body: stream, text: async () => "", headers: new Headers() });

    const provider = new OpenAIProvider({
      mode: "chatgpt-subscription",
      accessToken: "access-token",
      accountId: "account-id",
    });

    const chunks: string[] = [];
    const result = await provider.chatStream(
      "system",
      [{ role: "user", content: "ping" }],
      [],
      (c) => chunks.push(c),
    );

    // The keepalive must produce a progress signal (an empty-string chunk) so the
    // stall watchdog's markProgress fires; visible text must still stream too.
    expect(chunks).toContain("");
    expect(chunks).toContain("hi");
    expect(result.text).toBe("hi");
  });

  // Request a reasoning summary so gpt-5.x models stream their thinking — a dense
  // liveness heartbeat on top of keepalive. The summary deltas must surface as
  // empty progress chunks, NOT as visible answer text.
  it("requests reasoning summaries and treats summary deltas as progress (not answer text)", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          [
            "event: response.reasoning_summary_text.delta",
            'data: {"delta":"thinking about it"}',
            "",
            "event: response.output_text.delta",
            'data: {"delta":"answer"}',
            "",
            "event: response.completed",
            'data: {"response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2},"output":[{"id":"m","type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}]}}',
            "",
          ].join("\n"),
        ));
        controller.close();
      },
    });
    mockFetch.mockResolvedValue({ ok: true, body: stream, text: async () => "", headers: new Headers() });

    const provider = new OpenAIProvider({
      mode: "chatgpt-subscription",
      accessToken: "access-token",
      accountId: "account-id",
    });
    const chunks: string[] = [];
    const result = await provider.chatStream("system", [{ role: "user", content: "ping" }], [], (c) => chunks.push(c));

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.reasoning).toEqual({ summary: "auto" });
    expect(body.reasoning.effort).toBeUndefined(); // default reasoning depth preserved
    expect(chunks).toContain(""); // reasoning summary surfaced as progress heartbeat
    expect(result.text).toBe("answer"); // reasoning text NOT leaked into the answer
  });

  // A tool-call-only turn (no output_text) must still emit progress so the stall
  // watchdog sees the model is alive while tool-call arguments stream.
  it("treats subscription function-call argument streaming as stream progress", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          [
            'event: response.output_item.added',
            'data: {"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"do_thing","arguments":""}}',
            "",
            "event: response.function_call_arguments.delta",
            'data: {"item_id":"fc_1","delta":"{\\"x\\":1}"}',
            "",
            'event: response.output_item.done',
            'data: {"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"do_thing","arguments":"{\\"x\\":1}"}}',
            "",
            "event: response.completed",
            'data: {"response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2},"output":[]}}',
            "",
          ].join("\n"),
        ));
        controller.close();
      },
    });
    mockFetch.mockResolvedValue({ ok: true, body: stream, text: async () => "", headers: new Headers() });

    const provider = new OpenAIProvider({
      mode: "chatgpt-subscription",
      accessToken: "access-token",
      accountId: "account-id",
    });
    const chunks: string[] = [];
    const result = await provider.chatStream("system", [{ role: "user", content: "ping" }], [], (c) => chunks.push(c));

    expect(chunks).toContain(""); // function-call activity surfaced as progress
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("do_thing");
    expect(result.toolCalls[0]!.input).toEqual({ x: 1 });
  });

  // Regression (M2): the subscription /responses path must forward the caller's
  // AbortSignal so user/task cancel and the orchestrator stall-timeout can stop
  // the in-flight request instead of leaking the socket.
  it("forwards the AbortSignal to the subscription /responses fetch", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          [
            'event: response.completed',
            'data: {"response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2},"output":[{"id":"m","type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}}',
            "",
          ].join("\n"),
        ));
        controller.close();
      },
    });
    mockFetch.mockResolvedValue({ ok: true, body: stream, text: async () => "", headers: new Headers() });

    const provider = new OpenAIProvider({
      mode: "chatgpt-subscription",
      accessToken: "access-token",
      accountId: "account-id",
    });
    const ac = new AbortController();

    await provider.chatStream("system", [{ role: "user", content: "ping" }], [], () => {}, { signal: ac.signal });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/codex/responses",
      expect.objectContaining({ signal: ac.signal }),
    );
  });

  it("rejects the subscription stream when the AbortSignal is already aborted", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    mockFetch.mockResolvedValue({ ok: true, body: stream, text: async () => "", headers: new Headers() });

    const provider = new OpenAIProvider({
      mode: "chatgpt-subscription",
      accessToken: "access-token",
      accountId: "account-id",
    });
    const ac = new AbortController();
    ac.abort();

    await expect(
      provider.chatStream("system", [{ role: "user", content: "ping" }], [], () => {}, { signal: ac.signal }),
    ).rejects.toThrow(/aborted/i);
  });

  it("uses output_text for assistant replay on the subscription responses endpoint", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          [
            'event: response.completed',
            'data: {"response":{"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4},"output":[{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}',
            "",
          ].join("\n"),
        ));
        controller.close();
      },
    });

    mockFetch.mockResolvedValue({
      ok: true,
      body: stream,
      text: async () => "",
      headers: new Headers(),
    });

    const provider = new OpenAIProvider({
      mode: "chatgpt-subscription",
      accessToken: "access-token",
      accountId: "account-id",
    });

    await provider.chat(
      "system",
      [
        { role: "user", content: "start" },
        { role: "assistant", content: "previous answer" },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "call_1",
            content: { ok: true },
          }],
        },
      ],
      [],
    );

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "start" }],
      },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "previous answer" }],
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: '{"ok":true}',
      },
    ]);
  });

  it("performs a real subscription health probe against the responses endpoint", async () => {
    const cancel = vi.fn(async () => undefined);
    mockFetch.mockResolvedValue({
      ok: true,
      body: { cancel },
      headers: new Headers(),
    });

    const provider = new OpenAIProvider({
      mode: "chatgpt-subscription",
      accessToken: "access-token",
      accountId: "account-id",
    });

    await expect(provider.healthCheck()).resolves.toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/codex/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
          "ChatGPT-Account-Id": "account-id",
        }),
        signal: expect.any(AbortSignal),
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body).toMatchObject({
      model: "gpt-5.2",
      store: false,
      stream: true,
    });
    expect(body.max_output_tokens).toBeUndefined();
    expect(cancel).toHaveBeenCalled();
  });

  it("fails subscription health check when the responses endpoint rejects the probe", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
      headers: new Headers(),
    });

    const provider = new OpenAIProvider({
      mode: "chatgpt-subscription",
      accessToken: "bad-token",
      accountId: "account-id",
    });

    await expect(provider.healthCheck()).resolves.toBe(false);
  });

  it("surfaces a model-rejection reason (HTTP 400) instead of a sign-in prompt", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        detail: "The 'gpt-4.1-mini' model is not supported when using Codex with a ChatGPT account.",
      }),
      headers: new Headers(),
    });

    const provider = new OpenAIProvider(
      { mode: "chatgpt-subscription", accessToken: "valid-non-jwt-token", accountId: "account-id" },
      "gpt-4.1-mini",
    );

    await expect(provider.healthCheck()).resolves.toBe(false);
    const detail = provider.getLastHealthDetail();
    expect(detail).toContain("gpt-4.1-mini");
    expect(detail).toMatch(/not supported|not accepted/i);
    expect(detail).not.toMatch(/sign in again/i);
  });

  it("fails subscription health check locally when the token is already expired", async () => {
    const provider = new OpenAIProvider({
      mode: "chatgpt-subscription",
      accessToken: createJwt(-300),
      accountId: "account-id",
    });

    await expect(provider.healthCheck()).resolves.toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  describe("subscription listModels() reads the Codex models cache", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "codex-models-"));
    });

    function provider(authFile: string): OpenAIProvider {
      return new OpenAIProvider(
        { mode: "chatgpt-subscription", accessToken: "tok", accountId: "acct", authFile },
        "gpt-5.4",
      );
    }

    it("returns the slugs from the sibling models_cache.json (incl. this.model, deduped)", async () => {
      const authFile = join(dir, "auth.json");
      writeFileSync(
        join(dir, "models_cache.json"),
        JSON.stringify({
          fetched_at: "now",
          models: [
            { slug: "gpt-5.5", display_name: "GPT 5.5" },
            { slug: "gpt-5.4", display_name: "GPT 5.4" },
            { slug: "gpt-5.4-mini", display_name: "GPT 5.4 mini" },
            { slug: "gpt-5.3-codex-spark" },
          ],
        }),
      );

      const models = await provider(authFile).listModels();

      expect(models).toContain("gpt-5.5");
      expect(models).toContain("gpt-5.4-mini");
      expect(models).toContain("gpt-5.3-codex-spark");
      // this.model ("gpt-5.4") is present exactly once (deduped).
      expect(models.filter((m) => m === "gpt-5.4")).toHaveLength(1);
      // Did NOT hit the live /models endpoint.
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("falls back to [this.model] when the cache file is missing", async () => {
      const models = await provider(join(dir, "auth.json")).listModels();
      expect(models).toEqual(["gpt-5.4"]);
    });

    it("falls back to [this.model] when the cache file is unparseable", async () => {
      const authFile = join(dir, "auth.json");
      writeFileSync(join(dir, "models_cache.json"), "{ not json");
      const models = await provider(authFile).listModels();
      expect(models).toEqual(["gpt-5.4"]);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
