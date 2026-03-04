import { describe, it, expect, vi } from "vitest";
import { DeepSeekProvider } from "./deepseek.js";
import type { ConversationMessage } from "./provider.interface.js";

vi.mock("../../utils/logger.js", () => ({
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
});
