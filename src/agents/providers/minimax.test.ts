import { describe, it, expect, vi, beforeEach } from "vitest";
import { MiniMaxProvider } from "./minimax.js";

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock("../../utils/logger.js", () => ({
  getLogger: () => mockLogger,
  getLoggerSafe: () => mockLogger,
}));

describe("MiniMaxProvider", () => {
  const provider = new MiniMaxProvider("test-key");
  const parse = (data: unknown) =>
    (provider as unknown as { parseResponse: (d: unknown) => unknown }).parseResponse(data);

  it("has correct name and capabilities", () => {
    expect(provider.name).toBe("MiniMax");
    expect(provider.capabilities.maxTokens).toBe(131_072);
    expect(provider.capabilities.vision).toBe(false);
    expect(provider.capabilities.toolCalling).toBe(true);
  });

  describe("parseResponse - reasoning_details", () => {
    it("extracts reasoning_details and prepends to text", () => {
      const data = {
        choices: [{
          message: {
            content: "The answer is 7.",
            reasoning_details: "First, I need to add 3 + 4...",
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      };
      const result = parse(data) as { text: string };
      expect(result.text).toContain("<reasoning>");
      expect(result.text).toContain("First, I need to add 3 + 4...");
      expect(result.text).toContain("The answer is 7.");
    });

    it("returns plain text when no reasoning_details", () => {
      const data = {
        choices: [{
          message: { content: "Simple answer." },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      };
      const result = parse(data) as { text: string };
      expect(result.text).toBe("Simple answer.");
    });

    it("handles null reasoning_details", () => {
      const data = {
        choices: [{
          message: { content: "Answer.", reasoning_details: null },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      };
      const result = parse(data) as { text: string };
      expect(result.text).toBe("Answer.");
    });
  });

  describe("parseResponse - usage", () => {
    it("uses total_tokens from API when provided", () => {
      const data = {
        choices: [{
          message: { content: "test" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 20 },
      };
      const result = parse(data) as { usage: { totalTokens: number } };
      expect(result.usage.totalTokens).toBe(20);
    });

    it("calculates total when total_tokens not provided", () => {
      const data = {
        choices: [{
          message: { content: "test" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      const result = parse(data) as { usage: { totalTokens: number } };
      expect(result.usage.totalTokens).toBe(15);
    });
  });

  describe("parseResponse - tool calls", () => {
    it("parses tool calls correctly", () => {
      const data = {
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "calc", arguments: '{"x":1}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      const result = parse(data) as { toolCalls: Array<{ name: string }>; stopReason: string };
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]!.name).toBe("calc");
      expect(result.stopReason).toBe("tool_use");
    });
  });

  describe("extractStreamReasoning + extractStreamText (<think> handling)", () => {
    const extractText = (delta: Record<string, unknown> | undefined) =>
      (provider as unknown as { extractStreamText: (d: Record<string, unknown> | undefined) => string | undefined }).extractStreamText(delta);
    const extractReasoning = (delta: Record<string, unknown> | undefined) =>
      (provider as unknown as { extractStreamReasoning: (d: Record<string, unknown> | undefined) => string | undefined }).extractStreamReasoning(delta);

    it("returns reasoning_details from delta", () => {
      expect(extractReasoning({ reasoning_details: "thinking..." })).toBe("thinking...");
    });

    it("returns undefined for empty reasoning_details", () => {
      expect(extractReasoning({ reasoning_details: "" })).toBeUndefined();
    });

    it("passes normal content through extractStreamText", () => {
      expect(extractText({ content: "hello world" })).toBe("hello world");
    });

    it("suppresses <think> open tag from text stream", () => {
      expect(extractText({ content: "<think>" })).toBeUndefined();
    });

    it("suppresses content inside <think> block from text, routes to reasoning", () => {
      // Open the think block
      extractText({ content: "<think>" });
      // Content inside think block
      expect(extractText({ content: "I need to analyze..." })).toBeUndefined();
      expect(extractReasoning({ content: "I need to analyze..." })).toBe("I need to analyze...");
      // Close the think block
      extractText({ content: "</think>" });
      // Content after think block is visible again
      expect(extractText({ content: "Here is the answer" })).toBe("Here is the answer");
    });

    it("handles </think> with trailing visible text in same chunk", () => {
      extractText({ content: "<think>" });
      extractText({ content: "reasoning..." });
      // Closing tag + visible text in same delta
      const visible = extractText({ content: "</think>\nHere is my answer" });
      expect(visible).toBe("Here is my answer");
    });
  });

  describe("healthCheck", () => {
    const mockFetch = vi.fn();
    beforeEach(() => {
      vi.stubGlobal("fetch", mockFetch);
      mockFetch.mockReset();
    });

    it("returns true on HTTP 200 and cancels response body", async () => {
      const cancel = vi.fn();
      mockFetch.mockResolvedValueOnce({ ok: true, body: { cancel } });
      expect(await provider.healthCheck()).toBe(true);
      expect(cancel).toHaveBeenCalled();
      expect(mockFetch.mock.calls[0]![0]).toContain("/chat/completions");
    });

    it("returns false on non-2xx status", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
      expect(await provider.healthCheck()).toBe(false);
    });

    it("returns false on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network timeout"));
      expect(await provider.healthCheck()).toBe(false);
    });

    it("sends minimal payload with max_tokens 1", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: { cancel: vi.fn() } });
      await provider.healthCheck();
      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.max_tokens).toBe(1);
      expect(body.model).toBe("MiniMax-M2.7");
    });
  });
});
