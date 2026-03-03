import { vi, beforeEach } from "vitest";
import { ClaudeProvider } from "./claude.js";

vi.mock("@anthropic-ai/sdk", () => {
  const mockCreate = vi.fn();
  const mockStream = vi.fn();
  return {
    default: class MockAnthropic {
      messages = {
        create: mockCreate,
        stream: mockStream,
      };
    },
    __mockCreate: mockCreate,
    __mockStream: mockStream,
  };
});

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { __mockCreate: mockCreate } = await import("@anthropic-ai/sdk") as any;

describe("ClaudeProvider", () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ClaudeProvider("test-api-key");
  });

  it("returns correct text, empty toolCalls, and end_turn for a simple text response", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const result = await provider.chat(
      "system prompt",
      [{ role: "user", content: "Hi" }],
      []
    );

    expect(result.text).toBe("Hello!");
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("end_turn");
  });

  it("extracts tool calls correctly from a tool_use response", async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: "text", text: "Let me read that file." },
        {
          type: "tool_use",
          id: "toolu_01",
          name: "file_read",
          input: { path: "Assets/test.cs" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 200, output_tokens: 80 },
    });

    const result = await provider.chat(
      "system",
      [{ role: "user", content: "Read the file" }],
      [{ name: "file_read", description: "Read a file", input_schema: { type: "object" } }]
    );

    expect(result.text).toBe("Let me read that file.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: "toolu_01",
      name: "file_read",
      input: { path: "Assets/test.cs" },
    });
    expect(result.stopReason).toBe("tool_use");
  });

  it("passes tools as undefined when the tools array is empty", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    await provider.chat("system", [{ role: "user", content: "Hi" }], []);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ tools: undefined })
    );
  });

  it("maps stop reasons correctly: end_turn, tool_use, max_tokens", async () => {
    const cases = [
      { apiReason: "end_turn", expected: "end_turn" },
      { apiReason: "tool_use", expected: "tool_use" },
      { apiReason: "max_tokens", expected: "max_tokens" },
    ];

    for (const { apiReason, expected } of cases) {
      mockCreate.mockResolvedValue({
        content: [{ type: "text", text: "test" }],
        stop_reason: apiReason,
        usage: { input_tokens: 10, output_tokens: 10 },
      });

      const result = await provider.chat("sys", [{ role: "user", content: "x" }], []);
      expect(result.stopReason).toBe(expected);
    }
  });

  it("tracks usage with inputTokens and outputTokens", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const result = await provider.chat(
      "system",
      [{ role: "user", content: "Hi" }],
      []
    );

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
  });

  it("builds user messages as { role: 'user', content: ... }", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    await provider.chat(
      "system",
      [
        { role: "user", content: "Hello there" },
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "How are you?" },
      ],
      []
    );

    const callArgs = mockCreate.mock.calls[0]![0];
    expect(callArgs.messages).toEqual([
      { role: "user", content: "Hello there" },
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "How are you?" },
    ]);
  });

  it("builds tool result messages as tool_result blocks", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    await provider.chat(
      "system",
      [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tc_1", content: "file contents here", is_error: false },
          ],
        },
      ],
      []
    );

    const callArgs = mockCreate.mock.calls[0]![0];
    expect(callArgs.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tc_1",
          content: "file contents here",
          is_error: false,
        },
      ],
    });
  });

  it("builds assistant messages with tool_calls as tool_use blocks", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    await provider.chat(
      "system",
      [
        {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [
            { id: "tc_1", name: "file_read", input: { path: "test.cs" } },
          ],
        },
      ],
      []
    );

    const callArgs = mockCreate.mock.calls[0]![0];
    expect(callArgs.messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me check." },
        {
          type: "tool_use",
          id: "tc_1",
          name: "file_read",
          input: { path: "test.cs" },
        },
      ],
    });
  });
});
