import { describe, it, expect, vi, beforeEach } from "vitest";
import { GeminiProvider } from "./gemini.js";
import type { ConversationMessage } from "./provider.interface.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("GeminiProvider", () => {
  let provider: GeminiProvider;

  beforeEach(() => {
    provider = new GeminiProvider("test-key");
  });

  it("has correct name and defaults", () => {
    expect(provider.name).toBe("Google Gemini");
  });

  describe("parseResponse - thought_signature capture", () => {
    it("captures extra_content into providerMetadata", () => {
      const data = {
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function" as const,
              function: { name: "get_weather", arguments: '{"city":"Istanbul"}' },
              extra_content: { google: { thought_signature: "abc123" } },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };

      // Access protected method via cast
      const result = (provider as unknown as { parseResponse: (d: unknown) => unknown }).parseResponse(data);
      const response = result as { toolCalls: Array<{ providerMetadata?: Record<string, unknown> }> };

      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls[0]!.providerMetadata).toEqual({
        extra_content: { google: { thought_signature: "abc123" } },
      });
    });

    it("works without extra_content (older models)", () => {
      const data = {
        choices: [{
          message: {
            content: "Hello",
            tool_calls: [{
              id: "call_2",
              type: "function" as const,
              function: { name: "say_hello", arguments: '{}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      };

      const result = (provider as unknown as { parseResponse: (d: unknown) => unknown }).parseResponse(data);
      const response = result as { toolCalls: Array<{ providerMetadata?: Record<string, unknown> }> };

      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls[0]!.providerMetadata).toBeUndefined();
    });

    it("handles text-only response", () => {
      const data = {
        choices: [{
          message: { content: "Just text, no tools" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 10 },
      };

      const result = (provider as unknown as { parseResponse: (d: unknown) => unknown }).parseResponse(data);
      const response = result as { text: string; toolCalls: unknown[] };

      expect(response.text).toBe("Just text, no tools");
      expect(response.toolCalls).toHaveLength(0);
    });
  });

  describe("buildMessages - thought_signature echo", () => {
    it("echoes extra_content from providerMetadata on tool_calls", () => {
      const messages: ConversationMessage[] = [
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_1",
            name: "get_weather",
            input: { city: "Istanbul" },
            providerMetadata: {
              extra_content: { google: { thought_signature: "abc123" } },
            },
          }],
        },
      ];

      const result = (provider as unknown as {
        buildMessages: (s: string, m: ConversationMessage[]) => Array<{
          tool_calls?: Array<{ extra_content?: unknown }>;
        }>;
      }).buildMessages("System", messages);

      // result[0] is system, result[1] is assistant with tool_calls
      const assistantMsg = result[1]!;
      expect(assistantMsg.tool_calls).toHaveLength(1);
      expect(assistantMsg.tool_calls![0]!.extra_content).toEqual({
        google: { thought_signature: "abc123" },
      });
    });

    it("injects a dummy thought signature when no providerMetadata exists", () => {
      const messages: ConversationMessage[] = [
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_2",
            name: "say_hello",
            input: {},
          }],
        },
      ];

      const result = (provider as unknown as {
        buildMessages: (s: string, m: ConversationMessage[]) => Array<{
          tool_calls?: Array<Record<string, unknown>>;
        }>;
      }).buildMessages("System", messages);

      const assistantMsg = result[1]!;
      expect(assistantMsg.tool_calls).toHaveLength(1);
      expect(assistantMsg.tool_calls![0]!["extra_content"]).toEqual({
        google: { thought_signature: "skip_thought_signature_validator" },
      });
    });
  });
});
