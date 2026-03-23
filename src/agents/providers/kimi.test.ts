import { describe, it, expect, vi } from "vitest";
import { KimiProvider } from "./kimi.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Helper to access protected parseResponse
function getParseResponse(provider: KimiProvider) {
  return (data: unknown) =>
    (provider as unknown as { parseResponse: (d: unknown) => unknown }).parseResponse(data);
}

// Helper to access protected buildMessages
function getBuildMessages(provider: KimiProvider) {
  return (systemPrompt: string, messages: unknown[]) =>
    (provider as unknown as { buildMessages: (s: string, m: unknown[]) => unknown[] }).buildMessages(
      systemPrompt,
      messages,
    );
}

describe("KimiProvider", () => {
  it("has correct name and capabilities", () => {
    const provider = new KimiProvider("test-key");
    expect(provider.name).toBe("Kimi (Moonshot)");
    expect(provider.capabilities.maxTokens).toBe(8192);
    expect(provider.capabilities.vision).toBe(true);
    expect(provider.capabilities.toolCalling).toBe(true);
    expect(provider.capabilities.systemPrompt).toBe(true);
  });

  it("uses default model and base URL", () => {
    const provider = new KimiProvider("test-key");
    expect(provider.name).toBe("Kimi (Moonshot)");
  });

  it("accepts custom model and base URL", () => {
    const provider = new KimiProvider(
      "test-key",
      "kimi-k2.5",
      "https://api.moonshot.ai/v1",
    );
    expect(provider.name).toBe("Kimi (Moonshot)");
  });

  describe("parseResponse", () => {
    it("returns text content without reasoning when not present", () => {
      const provider = new KimiProvider("test-key");
      const parse = getParseResponse(provider);

      const data = {
        choices: [{
          message: { content: "Hello from Kimi" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      const result = parse(data) as { text: string; stopReason: string };
      expect(result.text).toBe("Hello from Kimi");
      expect(result.text).not.toContain("<reasoning>");
      expect(result.stopReason).toBe("end_turn");
    });

    it("embeds reasoning_content in text for round-trip survival", () => {
      const provider = new KimiProvider("test-key");
      const parse = getParseResponse(provider);

      const data = {
        choices: [{
          message: {
            content: "Hello",
            reasoning_content: "I think this is a greeting",
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      const result = parse(data) as { text: string };
      expect(result.text).toContain("<reasoning>");
      expect(result.text).toContain("I think this is a greeting");
      expect(result.text).toContain("Hello");
    });

    it("does not embed empty reasoning_content (Kimi rejects empty string)", () => {
      const provider = new KimiProvider("test-key");
      const parse = getParseResponse(provider);

      const data = {
        choices: [{
          message: { content: "Hello", reasoning_content: "" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      const result = parse(data) as { text: string };
      expect(result.text).toBe("Hello");
      expect(result.text).not.toContain("<reasoning>");
    });

    it("does not embed null reasoning_content", () => {
      const provider = new KimiProvider("test-key");
      const parse = getParseResponse(provider);

      const data = {
        choices: [{
          message: { content: "Hello", reasoning_content: null },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      const result = parse(data) as { text: string };
      expect(result.text).toBe("Hello");
    });

    it("preserves reasoning on tool_calls via providerMetadata", () => {
      const provider = new KimiProvider("test-key");
      const parse = getParseResponse(provider);

      const data = {
        choices: [{
          message: {
            content: null,
            reasoning_content: "thinking about tools",
            tool_calls: [{
              id: "tc1",
              type: "function",
              function: { name: "test_tool", arguments: "{}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      const result = parse(data) as {
        text: string;
        toolCalls: Array<{ providerMetadata?: Record<string, unknown> }>;
      };
      expect(result.toolCalls[0]!.providerMetadata?.reasoning_content).toBe(
        "thinking about tools",
      );
    });

    it("only attaches reasoning to first tool call", () => {
      const provider = new KimiProvider("test-key");
      const parse = getParseResponse(provider);

      const data = {
        choices: [{
          message: {
            content: null,
            reasoning_content: "my reasoning",
            tool_calls: [
              { id: "tc1", type: "function", function: { name: "tool_a", arguments: "{}" } },
              { id: "tc2", type: "function", function: { name: "tool_b", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      const result = parse(data) as {
        toolCalls: Array<{ providerMetadata?: Record<string, unknown> }>;
      };
      expect(result.toolCalls[0]!.providerMetadata?.reasoning_content).toBe("my reasoning");
      expect(result.toolCalls[1]!.providerMetadata).toBeUndefined();
    });
  });

  describe("buildMessages — reasoning_content round-trip", () => {
    it("extracts <reasoning> from assistant text and sets reasoning_content field", () => {
      const provider = new KimiProvider("test-key");
      const buildMessages = getBuildMessages(provider);

      const messages = buildMessages("system prompt", [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "<reasoning>\nI am thinking deeply\n</reasoning>\n\nHello there!",
        },
        { role: "user", content: "thanks" },
      ]) as Array<Record<string, unknown>>;

      const assistant = messages.find((m) => m.role === "assistant")!;
      expect(assistant.reasoning_content).toBe("I am thinking deeply");
      expect(assistant.content).toBe("Hello there!");
    });

    it("sets content to null when only reasoning exists", () => {
      const provider = new KimiProvider("test-key");
      const buildMessages = getBuildMessages(provider);

      const messages = buildMessages("system prompt", [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "<reasoning>\nonly thinking\n</reasoning>\n\n",
        },
      ]) as Array<Record<string, unknown>>;

      const assistant = messages.find((m) => m.role === "assistant")!;
      expect(assistant.reasoning_content).toBe("only thinking");
      expect(assistant.content).toBeNull();
    });

    it("sets reasoning_content to null on assistant messages without reasoning", () => {
      const provider = new KimiProvider("test-key");
      const buildMessages = getBuildMessages(provider);

      const messages = buildMessages("system prompt", [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Just a plain response" },
      ]) as Array<Record<string, unknown>>;

      const assistant = messages.find((m) => m.role === "assistant")!;
      expect(assistant.content).toBe("Just a plain response");
      expect(assistant.reasoning_content).toBeNull();
    });

    it("preserves system and user messages unchanged", () => {
      const provider = new KimiProvider("test-key");
      const buildMessages = getBuildMessages(provider);

      const messages = buildMessages("system prompt", [
        { role: "user", content: "hi <reasoning>not a block</reasoning>" },
      ]) as Array<Record<string, unknown>>;

      const user = messages.find((m) => m.role === "user")!;
      expect(user.content).toContain("<reasoning>");
    });
  });
});
