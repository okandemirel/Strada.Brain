import { describe, expect, it } from "vitest";
import { parseVisibilityReviewDecision, sanitizeVisibilityReviewDecision } from "./visibility-review.js";

const verdict = (text: string) => sanitizeVisibilityReviewDecision(parseVisibilityReviewDecision(text))?.decision;

describe("visibility review verdicts (AUT-19)", () => {
  // The caller keeps a draft internal only on the exact string
  // "internal_continue". The raw value used to pass straight through, so any
  // other spelling of the same verdict surfaced an internal memo to the user.
  it.each([
    '{"decision":"INTERNAL_CONTINUE","reason":"memo"}',
    '{"decision":"internal-continue"}',
    '{"decision":" Internal Continue "}',
    '```json\n{"decision":"internal_continue"}\n```',
    '"internal_continue"',
    "internal_continue — the draft is still a progress memo",
  ])("reads %j as internal_continue", (text) => {
    expect(verdict(text)).toBe("internal_continue");
  });

  it("reads an allow verdict as allow", () => {
    expect(verdict('{"decision":"ALLOW","reason":"final result"}')).toBe("allow");
  });

  it.each([
    '{"decision":"ship it"}',
    '{"decision":42}',
    "[1,2,3]",
    "I think this looks fine overall.",
  ])("names no verdict for %j instead of passing it through", (text) => {
    expect(verdict(text)).toBeUndefined();
  });

  it("keeps only string reasons, trimmed and bounded", () => {
    const decision = sanitizeVisibilityReviewDecision(
      parseVisibilityReviewDecision(`{"decision":"allow","reason":"${"r".repeat(300)}","recommendedNextAction":7}`),
    );
    expect(decision?.reason).toHaveLength(220);
    expect(decision?.recommendedNextAction).toBeUndefined();
  });
});
