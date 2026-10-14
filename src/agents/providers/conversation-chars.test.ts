/**
 * WHERE A TURN'S TOKENS COME FROM.
 *
 * Measured 2026-10-14 on the proof run: 241 turns at a median 89k input
 * tokens, 20.0M for one unfinished milestone, while the system prompt
 * accounted for ~20k tokens and the tool catalogue for ~9k. The rest is the
 * history the loop re-sends every turn — and no line measured it, so the
 * expense could not be aimed at anything.
 */
import { describe, expect, it } from "vitest";
import { conversationChars } from "./provider-call-log.js";

describe("conversationChars", () => {
  it("sums the history and names the largest single message", () => {
    expect(
      conversationChars([
        { content: "a".repeat(10) },
        { content: "b".repeat(1000) },
        { content: "c".repeat(30) },
      ]),
    ).toEqual({ historyChars: 1040, largestMessageChars: 1000 });
  });

  it("measures a structured content block without pretending it is empty", () => {
    const { historyChars, largestMessageChars } = conversationChars([
      { content: [{ type: "tool_result", text: "x".repeat(500) }] },
    ]);
    expect(historyChars).toBeGreaterThan(500);
    expect(largestMessageChars).toBe(historyChars);
  });

  it("answers zero for an empty or absent conversation", () => {
    expect(conversationChars([])).toEqual({ historyChars: 0, largestMessageChars: 0 });
    expect(conversationChars(undefined)).toEqual({ historyChars: 0, largestMessageChars: 0 });
    expect(conversationChars([{ content: undefined }, {}])).toEqual({ historyChars: 0, largestMessageChars: 0 });
  });

  it("does not throw on content that cannot be serialised", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(conversationChars([{ content: circular }])).toEqual({ historyChars: 0, largestMessageChars: 0 });
  });
});
