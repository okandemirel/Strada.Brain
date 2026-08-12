/**
 * Cross-provider TokenUsage contract.
 *
 * The upstream APIs disagree about what a "cached token" is. OpenAI's
 * `prompt_tokens_details.cached_tokens` and DeepSeek's
 * `prompt_cache_hit_tokens` are already counted inside their prompt total,
 * while Anthropic reports `input_tokens` as the *uncached remainder* and
 * carries the cached portion in separate fields.
 *
 * Left unnormalised, `inputTokens` means different things per provider and any
 * consumer that sums the parts double-counts on two of the three. TokenUsage
 * therefore fixes one convention — cache fields are subsets of inputTokens —
 * and providers normalise at their own boundary. These tests pin that, since
 * nothing else would catch a provider drifting back to its native shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TokenUsage } from "./provider-core.interface.js";

vi.mock("@anthropic-ai/sdk", () => {
  const mockCreate = vi.fn();
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate, stream: vi.fn() };
    },
    __mockCreate: mockCreate,
  };
});

vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const sdk = (await import("@anthropic-ai/sdk")) as unknown as {
  __mockCreate: ReturnType<typeof vi.fn>;
};

/** The invariants every provider's usage must satisfy. */
function expectContract(usage: TokenUsage): void {
  const cached = (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
  expect(usage.totalTokens, "totalTokens = inputTokens + outputTokens").toBe(
    usage.inputTokens + usage.outputTokens,
  );
  expect(cached, "cache fields are subsets of inputTokens").toBeLessThanOrEqual(usage.inputTokens);
}

describe("TokenUsage contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalises Anthropic's split counters into a whole-prompt inputTokens", async () => {
    const { ClaudeProvider } = await import("./claude.js");
    sdk.__mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      // Anthropic's shape: input_tokens is what was NOT served from cache.
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 700,
      },
    });

    const provider = new ClaudeProvider("test-api-key");
    const { usage } = await provider.chat("sys", [{ role: "user", content: "hi" }], []);

    // The real prompt was 1000 tokens, not the 100 Anthropic puts in input_tokens.
    expect(usage).toEqual({
      inputTokens: 1000,
      outputTokens: 50,
      totalTokens: 1050,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 700,
    });
    expectContract(usage!);
  });

  it("omits the cache fields entirely when Anthropic reports no caching", async () => {
    const { ClaudeProvider } = await import("./claude.js");
    sdk.__mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const provider = new ClaudeProvider("test-api-key");
    const { usage } = await provider.chat("sys", [{ role: "user", content: "hi" }], []);

    expect(usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    expectContract(usage!);
  });

  it("accepts the already-subset shape OpenAI and DeepSeek report", () => {
    // Both send the full prompt count plus a cached share of it; no
    // normalisation needed, but the contract must still hold.
    expectContract({
      inputTokens: 1000,
      outputTokens: 50,
      totalTokens: 1050,
      cacheReadInputTokens: 900,
    });
  });

  it("would reject the pre-normalisation Anthropic shape", () => {
    // Guard the guard: this is what the provider used to emit — inputTokens as
    // the remainder, cache fields added on top. It must not satisfy the
    // contract, otherwise the assertions above prove nothing.
    expect(() =>
      expectContract({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 1050,
        cacheCreationInputTokens: 200,
        cacheReadInputTokens: 700,
      }),
    ).toThrow();
  });
});
