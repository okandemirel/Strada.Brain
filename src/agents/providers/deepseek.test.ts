import { describe, it, expect, vi } from "vitest";
import { DeepSeekProvider } from "./deepseek.js";
import type { ConversationMessage } from "./provider.interface.js";

vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("DeepSeekProvider", () => {
  const provider = new DeepSeekProvider("test-key");
  const parse = (data: unknown) =>
    (provider as unknown as { parseResponse: (d: unknown) => unknown }).parseResponse(data);
  const build = (sys: string, msgs: ConversationMessage[]) =>
    (provider as unknown as { buildMessages: (s: string, m: ConversationMessage[]) => unknown[] }).buildMessages(sys, msgs);

  it("has correct name and capabilities", () => {
    expect(provider.name).toBe("DeepSeek");
    expect(provider.capabilities.vision).toBe(false);
    expect(provider.capabilities.maxTokens).toBe(8192);
  });

  describe("parseResponse - reasoning_content", () => {
    it("extracts reasoning_content and prepends to text", () => {
      const data = {
        choices: [{
          message: {
            content: "The answer is 42.",
            reasoning_content: "Let me think step by step...",
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      };
      const result = parse(data) as { text: string };
      expect(result.text).toContain("<reasoning>");
      expect(result.text).toContain("Let me think step by step...");
      expect(result.text).toContain("The answer is 42.");
    });

    it("returns plain text when no reasoning_content", () => {
      const data = {
        choices: [{
          message: { content: "Simple answer." },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      };
      const result = parse(data) as { text: string };
      expect(result.text).toBe("Simple answer.");
      expect(result.text).not.toContain("<reasoning>");
    });

    it("handles null reasoning_content", () => {
      const data = {
        choices: [{
          message: { content: "Answer.", reasoning_content: null },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      };
      const result = parse(data) as { text: string };
      expect(result.text).toBe("Answer.");
    });
  });

  describe("parseResponse - cache stats", () => {
    it("captures cache hit tokens in usage", () => {
      const data = {
        choices: [{
          message: { content: "cached" },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 20,
        },
      };
      const result = parse(data) as { usage: { cacheReadInputTokens?: number; totalTokens: number } };
      expect(result.usage.cacheReadInputTokens).toBe(80);
      expect(result.usage.totalTokens).toBe(150);
    });

    it("uses calculated total when total_tokens not provided", () => {
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
              function: { name: "search", arguments: '{"q":"test"}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      const result = parse(data) as { toolCalls: Array<{ name: string }>; stopReason: string };
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]!.name).toBe("search");
      expect(result.stopReason).toBe("tool_use");
    });
  });

  describe("buildMessages - reasoning stripping", () => {
    it("strips reasoning blocks from assistant messages", () => {
      const messages: ConversationMessage[] = [{
        role: "assistant",
        content: "<reasoning>\nStep 1: think\n</reasoning>\n\nFinal answer.",
      }];
      const result = build("system", messages) as Array<{ role: string; content: string | null }>;
      const assistantMsg = result.find(m => m.role === "assistant");
      expect(assistantMsg!.content).toBe("Final answer.");
    });

    it("preserves messages without reasoning blocks", () => {
      const messages: ConversationMessage[] = [{
        role: "assistant",
        content: "Plain answer.",
      }];
      const result = build("system", messages) as Array<{ role: string; content: string | null }>;
      const assistantMsg = result.find(m => m.role === "assistant");
      expect(assistantMsg!.content).toBe("Plain answer.");
    });
  });

  // PRV-16: thinking mode rejects a replayed tool-call turn without its
  // reasoning_content (400 "must be passed back to the API"); the adapter
  // stripped the reasoning and never set the field.
  describe("buildMessages - reasoning_content echo on tool-call turns", () => {
    type Built = Array<{ role: string; content: string | null; reasoning_content?: string }>;
    const toolTurn = (content: string): ConversationMessage[] => [
      { role: "user", content: "read it" },
      { role: "assistant", content, tool_calls: [{ id: "call_1", name: "file_read", input: { path: "a.cs" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
    ];

    it("echoes the retained reasoning and keeps it out of the visible content", () => {
      const reasoner = new DeepSeekProvider("k", "deepseek-reasoner");
      const result = (reasoner as unknown as { buildMessages: typeof build }).buildMessages(
        "system", toolTurn("<reasoning>\nI should read the file first.\n</reasoning>\n\n"),
      ) as Built;
      const assistant = result.find((m) => m.role === "assistant")!;
      expect(assistant.reasoning_content).toBe("I should read the file first.");
      expect(assistant.content ?? "").not.toContain("<reasoning>");
    });

    it("sends a placeholder for a thinking model whose reasoning was not retained", () => {
      const reasoner = new DeepSeekProvider("k", "deepseek-reasoner");
      const result = (reasoner as unknown as { buildMessages: typeof build }).buildMessages("system", toolTurn("")) as Built;
      expect(result.find((m) => m.role === "assistant")!.reasoning_content).toBeTruthy();
    });

    it("leaves a non-thinking tool-call turn without the field", () => {
      const result = build("system", toolTurn("Reading it.")) as Built;
      expect(result.find((m) => m.role === "assistant")).not.toHaveProperty("reasoning_content");
    });
  });
});
