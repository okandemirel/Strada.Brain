import { describe, it, expect } from "vitest";
import type { ConversationMessage } from "./providers/provider-core.interface.ts";
import type { CompactableMessage } from "./session-compaction.ts";
import { compactSession, estimateTokens } from "./session-compaction.ts";

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

/** Builds an alternating user/assistant conversation with fixed-size contents. */
function buildConversation(count: number, charsPerMessage: number): ConversationMessage[] {
  return Array.from({ length: count }, (_, i): ConversationMessage =>
    i % 2 === 0
      ? { role: "user", content: `u${i}-`.padEnd(charsPerMessage, "x") }
      : { role: "assistant", content: `a${i}-`.padEnd(charsPerMessage, "y") },
  );
}

describe("compactSession", () => {
  it("returns compacted: false and untouched messages when under budget", () => {
    // Type-level assertion: plain ConversationMessage[] is accepted with no casts.
    const messages: ConversationMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    const result = compactSession(messages, { maxTokens: 1000 });
    expect(result.compacted).toBe(false);
    expect(result.stageApplied).toBeNull();
    expect(result.messages).toEqual(messages);
    expect(result.summary).toBeUndefined();
  });

  it("returns system-free messages and a summary when stage 2 (summarization) runs", () => {
    const messages = buildConversation(20, 400); // ~2000 tokens
    const result = compactSession(messages, { maxTokens: 1500 });
    expect(result.compacted).toBe(true);
    expect(result.stageApplied).toBe("summarization");
    expect(result.messages.every((m) => String(m.role) !== "system")).toBe(true);
    expect(result.summary).toBeTruthy();
    expect(result.summary).toContain("Compacted conversation summary");
    // The 4 most recent messages survive summarization
    expect(result.messages).toEqual(messages.slice(-4));
  });

  it("merges previousSummary into the returned summary", () => {
    const messages = buildConversation(20, 400);
    const result = compactSession(messages, {
      maxTokens: 1500,
      previousSummary: "old summary",
    });
    expect(result.compacted).toBe(true);
    expect(result.summary).toContain("old summary");
    expect(result.messages.every((m) => String(m.role) !== "system")).toBe(true);
  });

  it("round-trips previousSummary unchanged when no compaction occurs", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "short" },
      { role: "assistant", content: "reply" },
    ];
    const result = compactSession(messages, {
      maxTokens: 1000,
      previousSummary: "keep me",
    });
    expect(result.compacted).toBe(false);
    expect(result.summary).toBe("keep me");
    expect(result.messages).toEqual(messages);
  });

  it("counts previousSummary toward the budget on the early-return path", () => {
    const messages: ConversationMessage[] = [{ role: "user", content: "hi" }];
    const withSummary = compactSession(messages, {
      maxTokens: 1000,
      previousSummary: "s".repeat(400),
    });
    const withoutSummary = compactSession(messages, { maxTokens: 1000 });
    expect(withSummary.originalTokens).toBeGreaterThan(withoutSummary.originalTokens);
  });

  it("stage-4 hard truncation still returns a system-free messages array", () => {
    // 10 big messages followed by 2 tiny ones: summarization cannot fit the
    // budget (kept recents are too big), so the pipeline falls through to
    // hard truncation, which keeps only the tiny recent messages.
    const big = buildConversation(10, 2000);
    const tiny: ConversationMessage[] = [
      { role: "user", content: "tiny user question" },
      { role: "assistant", content: "tiny answer" },
    ];
    const messages = [...big, ...tiny];
    const result = compactSession(messages, { maxTokens: 500 });
    expect(result.compacted).toBe(true);
    expect(result.stageApplied).toBe("hard_truncation");
    expect(result.messages.every((m) => String(m.role) !== "system")).toBe(true);
    expect(result.messages).toEqual(tiny);
    expect(result.summary).toBeTruthy();
    expect(result.finalTokens).toBeLessThanOrEqual(500);
  });
});
