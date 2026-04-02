import { describe, it, expect } from "vitest";
import type { CompactableMessage } from "./session-compaction.ts";
import { estimateTokens } from "./session-compaction.ts";

describe("estimateTokens", () => {
  it("estimateTokens includes system prompt overhead when provided", () => {
    const messages: CompactableMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    const withoutOverhead = estimateTokens(messages);
    const withOverhead = estimateTokens(messages, 40000);
    expect(withOverhead).toBeGreaterThan(withoutOverhead);
    expect(withOverhead - withoutOverhead).toBe(Math.ceil(40000 / 4));
  });

  it("estimateTokens returns 0 for empty messages and no system prompt", () => {
    expect(estimateTokens([])).toBe(0);
    expect(estimateTokens([], 0)).toBe(0);
  });

  it("estimateTokens counts only system prompt when messages are empty", () => {
    expect(estimateTokens([], 4000)).toBe(1000);
  });
});
