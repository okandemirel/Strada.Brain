import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeProvider } from "./claude.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

describe("ClaudeProvider", () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    provider = new ClaudeProvider("test-api-key");
  });

  it("has correct name", () => {
    expect(provider.name).toBe("claude");
  });

  it("parses text response correctly", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    const result = await provider.chat("system", [{ role: "user", content: "Hi" }], []);
    expect(result.text).toBe("Hello!");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(20);
  });

  it("parses tool_use response correctly", async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: "text", text: "Let me read that file." },
        { type: "tool_use", id: "tc_123", name: "file_read", input: { path: "test.cs" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 200, output_tokens: 50 },
    });

    const result = await provider.chat("system", [{ role: "user", content: "Read file" }], [
      { name: "file_read", description: "Read file", input_schema: { type: "object" } },
    ]);

    expect(result.text).toBe("Let me read that file.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.id).toBe("tc_123");
    expect(result.toolCalls[0]!.name).toBe("file_read");
    expect(result.toolCalls[0]!.input).toEqual({ path: "test.cs" });
    expect(result.stopReason).toBe("tool_use");
  });

  it("concatenates multiple text blocks", async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: "text", text: "Part 1. " },
        { type: "text", text: "Part 2." },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 30 },
    });

    const result = await provider.chat("system", [{ role: "user", content: "Hi" }], []);
    expect(result.text).toBe("Part 1. Part 2.");
  });

  it("does not send tools when array is empty", async () => {
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

  it("maps max_tokens stop reason", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Truncated..." }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 100, output_tokens: 4096 },
    });

    const result = await provider.chat("system", [{ role: "user", content: "Long" }], []);
    expect(result.stopReason).toBe("max_tokens");
  });

  it("builds user messages correctly", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    await provider.chat("system", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ], []);

    const callArgs = mockCreate.mock.calls[0]![0];
    expect(callArgs.messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ]);
  });

  it("builds tool result messages correctly", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    await provider.chat("system", [
      {
        role: "user", content: "",
        toolResults: [{ toolCallId: "tc1", content: "file contents", isError: false }],
      },
    ], []);

    const callArgs = mockCreate.mock.calls[0]![0];
    expect(callArgs.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tc1", content: "file contents", is_error: false },
      ],
    });
  });

  it("builds assistant messages with tool calls", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    await provider.chat("system", [
      {
        role: "assistant", content: "Let me check.",
        toolCalls: [{ id: "tc1", name: "file_read", input: { path: "x" } }],
      },
    ], []);

    const callArgs = mockCreate.mock.calls[0]![0];
    expect(callArgs.messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "tc1", name: "file_read", input: { path: "x" } },
      ],
    });
  });
});
