import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MiniMaxProvider } from "./minimax.js";
import type { StreamParseState } from "./openai.js";

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
    type Hook = (d: Record<string, unknown> | undefined, state: StreamParseState) => string | undefined;
    // One parse state per test, as the base stream loop keeps one per stream.
    let state: StreamParseState;
    beforeEach(() => { state = {}; });
    const extractText = (delta: Record<string, unknown> | undefined) =>
      (provider as unknown as { extractStreamText: Hook }).extractStreamText(delta, state);
    const extractReasoning = (delta: Record<string, unknown> | undefined) =>
      (provider as unknown as { extractStreamReasoning: Hook }).extractStreamReasoning(delta, state);

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

    // Regression (M3): a whole <think>…</think> block plus trailing text in ONE
    // delta must surface the trailing visible text, not drop it.
    it("surfaces trailing visible text when a whole think block arrives in one chunk", () => {
      expect(extractText({ content: "<think>reasoning</think>Hello" })).toBe("Hello");
    });

    it("does not double-emit single-chunk trailing visible text into reasoning", () => {
      const delta = { content: "<think>reasoning</think>Hello" };
      expect(extractText(delta)).toBe("Hello");
      // extractStreamReasoning runs after extractStreamText; reasoning must be
      // only the think portion, not the trailing visible "Hello".
      expect(extractReasoning(delta)).toBe("<think>reasoning</think>");
    });

    // Regression (H3): a stream that ended inside a <think> block must not blank
    // the NEXT stream. The state is per stream now, so there is nothing to reset.
    it("a new parse state starts outside any think block", () => {
      extractText({ content: "<think>" });
      expect(state.inThinkBlock).toBe(true);
      const fresh: StreamParseState = {};
      expect((provider as unknown as { extractStreamText: Hook }).extractStreamText({ content: "visible" }, fresh))
        .toBe("visible");
    });
  });

  // PRV-11: one provider object serves concurrent streams (chains are shared
  // across chats and parallel goal nodes). The <think> flag lived on the
  // provider, so stream A opening a think block suppressed stream B's answer.
  describe("concurrent streams on one provider", () => {
    const encoder = new TextEncoder();
    function controlledBody() {
      let ctrl!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
      return {
        response: { ok: true, status: 200, body, headers: new Headers(), text: async () => "" },
        send: (content: string) => ctrl.enqueue(encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
        )),
        end: () => { ctrl.enqueue(encoder.encode("data: [DONE]\n\n")); ctrl.close(); },
      };
    }
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
    afterEach(() => { vi.unstubAllGlobals(); });

    it("keeps each stream's think-block state to itself", async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);
      const a = controlledBody();
      const b = controlledBody();
      mockFetch.mockResolvedValueOnce(a.response).mockResolvedValueOnce(b.response);
      const shared = new MiniMaxProvider("test-key");
      const seenA: string[] = [];
      const seenB: string[] = [];

      const streamA = shared.chatStream("sys", [{ role: "user", content: "a" }], [], (c) => { seenA.push(c); });
      await settle();
      const streamB = shared.chatStream("sys", [{ role: "user", content: "b" }], [], (c) => { seenB.push(c); });
      await settle();

      a.send("<think>");
      await settle();
      b.send("Answer B");
      await settle();
      a.send("still thinking");
      await settle();
      a.send("</think>Answer A");
      a.end();
      b.end();

      const [resultA, resultB] = await Promise.all([streamA, streamB]);
      expect(resultB.text).toBe("Answer B");
      expect(seenB).toContain("Answer B");
      expect(resultA.text).toMatch(/Answer A$/u);
      expect(seenA.join("")).not.toContain("still thinking");
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
