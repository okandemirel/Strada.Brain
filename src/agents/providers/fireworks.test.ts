import { describe, it, expect, vi } from "vitest";
import { FireworksProvider } from "./fireworks.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("FireworksProvider", () => {
  const provider = new FireworksProvider("test-key");
  const parse = (data: unknown) =>
    (provider as unknown as { parseResponse: (d: unknown) => unknown }).parseResponse(data);

  it("has correct name and capabilities", () => {
    expect(provider.name).toBe("Fireworks AI");
    expect(provider.capabilities.maxTokens).toBe(4096);
    expect(provider.capabilities.vision).toBe(true);
    expect(provider.capabilities.toolCalling).toBe(true);
  });

  it("uses API total_tokens when provided", () => {
    const data = {
      choices: [{
        message: { content: "Hello from Fireworks" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 20 },
    };
    const result = parse(data) as { text: string; usage: { totalTokens: number } };
    expect(result.text).toBe("Hello from Fireworks");
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

  it("parses tool calls correctly", () => {
    const data = {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "generate", arguments: '{"prompt":"hello"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const result = parse(data) as { toolCalls: Array<{ name: string }>; stopReason: string };
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("generate");
    expect(result.stopReason).toBe("tool_use");
  });
});
