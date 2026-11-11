import { describe, it, expect, vi, beforeEach } from "vitest";
import { GeminiProvider } from "./gemini.js";
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

  describe("parseResponse - prompt cache share", () => {
    it("keeps the provider's cache share, 0 included, and none when absent", () => {
      const base = { choices: [{ message: { content: "x" }, finish_reason: "stop" }] };
      const p = (u: Record<string, unknown>) => ((provider as unknown as { parseResponse: (d: unknown) => unknown }).parseResponse({ ...base, usage: u })) as { usage: Record<string, unknown> };
      expect(p({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 6 } }).usage)
        .toMatchObject({ cacheReadInputTokens: 6, cacheReadField: "prompt_tokens_details.cached_tokens" });
      expect(p({ prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 0 }).usage)
        .toMatchObject({ cacheReadInputTokens: 0, cacheReadField: "prompt_cache_hit_tokens" });
      expect(p({ prompt_tokens: 10, completion_tokens: 1 }).usage).not.toHaveProperty("cacheReadInputTokens");
    });
  });

  describe("chatStream - prompt cache share", () => {
    it("reads the cache share off the final usage chunk, 0 included", async () => {
      const sse = (usage: Record<string, unknown>) =>
        [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\n`,
          "data: [DONE]\n\n",
        ].join("");
      for (const [usage, expected] of [
        [{ prompt_tokens: 20, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } }, { cacheReadInputTokens: 0, cacheReadField: "prompt_tokens_details.cached_tokens" }],
        [{ prompt_tokens: 20, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 12 } }, { cacheReadInputTokens: 12, cacheReadField: "prompt_tokens_details.cached_tokens" }],
      ] as const) {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(sse(usage), { status: 200, headers: { "content-type": "text/event-stream" } })));
        const res = await provider.chatStream("sys", [{ role: "user", content: "hello" }], [], () => {});
        expect(res.usage).toMatchObject({ inputTokens: 20, ...expected });
      }
      vi.unstubAllGlobals();
    });
  });
});
