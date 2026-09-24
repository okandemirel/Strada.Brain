/**
 * One empty answer is not an outage.
 *
 * Measured 2026-08-22, run 39: OpenCode returned six empty responses inside
 * nine seconds and the run ended with "All providers failed". Probed directly
 * two minutes later, the same provider answered normally — the condition was
 * transient and had already passed while the task was being torn down.
 *
 * The chain already calls an empty response "a retryable failure so the next
 * healthy provider is tried". With Kimi benched on quota there was no next
 * healthy provider, so retryable meant nothing and one bad answer from the only
 * live provider killed the run.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { FallbackChainProvider } from "./fallback-chain.js";
import { createMockProvider } from "../../test-helpers.js";
import { ProviderHealthRegistry } from "./provider-health.js";

vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe("an empty answer from the only live provider", () => {
  beforeEach(() => {
    ProviderHealthRegistry.resetInstance();
  });

  it("asks again instead of declaring every provider dead", async () => {
    const only = createMockProvider();
    (only.chat as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ text: "", toolCalls: [] })
      .mockResolvedValueOnce({ text: "the answer on the second ask", toolCalls: [] });

    const chain = new FallbackChainProvider([only]);
    const result = await chain.chat("sys", [], []);

    expect(result.text).toBe("the answer on the second ask");
    expect(only.chat).toHaveBeenCalledTimes(2);
  });

  it("gives up when the second ask is empty too", async () => {
    // The retry is one extra chance, not a loop. A provider answering nothing
    // twice really has nothing to say.
    const only = createMockProvider();
    (only.chat as ReturnType<typeof vi.fn>).mockResolvedValue({ text: "", toolCalls: [] });

    const chain = new FallbackChainProvider([only]);

    await expect(chain.chat("sys", [], [])).rejects.toThrow();
    expect(only.chat).toHaveBeenCalledTimes(2);
  });

  it("still prefers a different provider over asking the same one twice", async () => {
    // Falling through is the better answer when there is somewhere to fall to.
    const first = createMockProvider();
    (first.chat as ReturnType<typeof vi.fn>).mockResolvedValue({ text: "", toolCalls: [] });
    const second = createMockProvider({ text: "from the second provider" });

    const chain = new FallbackChainProvider([first, second]);
    const result = await chain.chat("sys", [], []);

    expect(result.text).toBe("from the second provider");
  });

  it("does not retry a provider that threw a real error", async () => {
    // A 403 will be a 403 again; only an empty answer earns the second ask.
    const only = createMockProvider();
    (only.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("API error 403: nope"));

    const chain = new FallbackChainProvider([only]);

    await expect(chain.chat("sys", [], [])).rejects.toThrow();
    expect(only.chat).toHaveBeenCalledTimes(1);
  });
});

// PRV-13: a thinking model that spent its whole budget reasoning returns no
// content and no tool calls — but the adapters splice the reasoning into
// `text`, so the answer looked non-empty, the chain recorded a success, and the
// user got nothing once the reasoning block was stripped downstream.
describe("an answer that is only reasoning", () => {
  beforeEach(() => {
    ProviderHealthRegistry.resetInstance();
  });

  it.each([
    ["a closed <reasoning> block", "<reasoning>\nlet me think about the schema {\"a\":1}\n</reasoning>\n\n"],
    ["a closed <think> block", "<think>hmm</think>"],
    ["an unclosed <think> block", "<think>still going when the budget ran out"],
  ])("counts %s as empty and falls over to the sibling", async (_label, text) => {
    const thinker = createMockProvider();
    (thinker.chat as ReturnType<typeof vi.fn>).mockResolvedValue({ text, toolCalls: [] });
    const second = createMockProvider({ text: "a real answer" });

    const result = await new FallbackChainProvider([thinker, second]).chat("sys", [], []);

    expect(result.text).toBe("a real answer");
    expect(second.chat).toHaveBeenCalledTimes(1);
  });

  it("keeps an answer whose visible text follows the reasoning", async () => {
    const thinker = createMockProvider({ text: "<reasoning>\nplan\n</reasoning>\n\nthe answer" });
    const second = createMockProvider({ text: "unused" });

    const result = await new FallbackChainProvider([thinker, second]).chat("sys", [], []);

    expect(result.text).toContain("the answer");
    expect(second.chat).not.toHaveBeenCalled();
  });
});
