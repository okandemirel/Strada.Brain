import { vi, beforeEach } from "vitest";
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

  it("fails subscription health check locally when the token is already expired", async () => {
    const provider = new OpenAIProvider({
      mode: "chatgpt-subscription",
      accessToken: createJwt(-300),
      accountId: "account-id",
    });

    await expect(provider.healthCheck()).resolves.toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
