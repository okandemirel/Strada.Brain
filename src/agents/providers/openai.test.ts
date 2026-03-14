import { vi, beforeEach } from "vitest";
import { OpenAIProvider } from "./openai.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
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
});
