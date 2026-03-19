import { describe, expect, it } from "vitest";
import { derivePhaseVerdict, scorePhaseVerdictFallback } from "./phase-verdict.js";

describe("phase-verdict", () => {
  it("derives clean verdicts for approved phases", () => {
    expect(derivePhaseVerdict("approved", "approve")).toEqual({
      label: "clean",
      score: 1,
    });
    expect(derivePhaseVerdict("approved")).toEqual({
      label: "clean",
      score: 0.9,
    });
  });

  it("derives retry and failure verdicts for continued and failed phases", () => {
    expect(derivePhaseVerdict("continued", "continue")).toEqual({
      label: "retry",
      score: 0.62,
    });
    expect(derivePhaseVerdict("replanned", "replan")).toEqual({
      label: "failure",
      score: 0.18,
    });
    expect(derivePhaseVerdict("failed")).toEqual({
      label: "failure",
      score: 0,
    });
  });

  it("falls back to a neutral score when no status exists", () => {
    expect(scorePhaseVerdictFallback(undefined)).toBe(0.55);
  });
});
