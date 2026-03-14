import { describe, it, expect, vi } from "vitest";
import { TogetherProvider } from "./together.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("TogetherProvider", () => {
  const provider = new TogetherProvider("test-key");
  const parse = (data: unknown) =>
    (provider as unknown as { parseResponse: (d: unknown) => unknown }).parseResponse(data);

  it("has correct name and capabilities", () => {
    expect(provider.name).toBe("Together AI");
    expect(provider.capabilities.maxTokens).toBe(4096);
    expect(provider.capabilities.vision).toBe(false);
    expect(provider.capabilities.toolCalling).toBe(true);
  });

  it("uses API total_tokens when provided", () => {
    const data = {
      choices: [{
        message: { content: "Hello from Together" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 18 },
    };
    const result = parse(data) as { text: string; usage: { totalTokens: number } };
    expect(result.text).toBe("Hello from Together");
    expect(result.usage.totalTokens).toBe(18);
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

  it("parses tool calls correctly", () => {
    const data = {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "code_search", arguments: '{"query":"test"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const result = parse(data) as { toolCalls: Array<{ name: string }>; stopReason: string };
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("code_search");
    expect(result.stopReason).toBe("tool_use");
  });
});
