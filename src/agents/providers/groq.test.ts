import { describe, it, expect, vi } from "vitest";
import { GroqProvider } from "./groq.js";
import { getLogger } from "../../utils/logger.js";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};
vi.mock("../../utils/logger.js", () => ({
  getLogger: () => mockLogger,
}));

describe("GroqProvider", () => {
  const provider = new GroqProvider("test-key");
  const parse = (data: unknown) =>
    (provider as unknown as { parseResponse: (d: unknown) => unknown }).parseResponse(data);

  it("has correct name and capabilities", () => {
    expect(provider.name).toBe("Groq");
    expect(provider.capabilities.maxTokens).toBe(8192);
    expect(provider.capabilities.vision).toBe(true);
  });

  it("logs x_groq request ID when present", () => {
    const data = {
      choices: [{
        message: { content: "Fast response" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      x_groq: { id: "req_01jbd6g2qdfw2adyrt2az8hz4w" },
    };
    parse(data);
    expect(mockLogger.debug).toHaveBeenCalledWith("Groq request", {
      requestId: "req_01jbd6g2qdfw2adyrt2az8hz4w",
    });
  });

  it("parses response normally without x_groq", () => {
    const data = {
      choices: [{
        message: { content: "No metadata" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    };
    const result = parse(data) as { text: string };
    expect(result.text).toBe("No metadata");
  });

  it("parses tool calls via parent", () => {
    const data = {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "test", arguments: '{}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const result = parse(data) as { toolCalls: Array<{ name: string }>; stopReason: string };
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("test");
    expect(result.stopReason).toBe("tool_use");
  });
});
