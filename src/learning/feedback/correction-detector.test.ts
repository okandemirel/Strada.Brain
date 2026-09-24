import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CorrectionDetector } from "./correction-detector.ts";

describe("CorrectionDetector", () => {
  describe("isCorrection", () => {
    it("should detect EN correction patterns", () => {
      expect(CorrectionDetector.isCorrection("no, use const instead")).toBe(true);
      expect(CorrectionDetector.isCorrection("wrong, it should be async")).toBe(true);
      expect(CorrectionDetector.isCorrection("instead use the other method")).toBe(true);
      expect(CorrectionDetector.isCorrection("that's incorrect, fix it")).toBe(true);
      expect(CorrectionDetector.isCorrection("actually, do it this way")).toBe(true);
      expect(CorrectionDetector.isCorrection("not like that, do it differently")).toBe(true);
    });

    it("should detect TR correction patterns", () => {
      expect(CorrectionDetector.isCorrection("hayir, const kullan")).toBe(true);
      expect(CorrectionDetector.isCorrection("yanlis, async olmali")).toBe(true);
      expect(CorrectionDetector.isCorrection("dogru degil, baska yol dene")).toBe(true);
    });

    it("should be case-insensitive", () => {
      expect(CorrectionDetector.isCorrection("NO, use const")).toBe(true);
      expect(CorrectionDetector.isCorrection("Wrong answer")).toBe(true);
      expect(CorrectionDetector.isCorrection("HAYIR, bu yanlis")).toBe(true);
    });

    it("does not read a long message as a correction, whatever words it contains", () => {
      // A pasted document or spec that happens to say "instead" is new input,
      // not a reply to the agent's last turn — it used to be stored whole.
      const pasted = `Here is the design doc. ${"Use the pooled loader instead of allocating per frame. ".repeat(20)}`;

      expect(CorrectionDetector.isCorrection(pasted)).toBe(false);
      expect(CorrectionDetector.isCorrection("no, use the pooled loader instead")).toBe(true);
    });

    it("should return false for non-correction text", () => {
      expect(CorrectionDetector.isCorrection("please fix the bug")).toBe(false);
      expect(CorrectionDetector.isCorrection("run the tests")).toBe(false);
      expect(CorrectionDetector.isCorrection("looks good")).toBe(false);
      expect(CorrectionDetector.isCorrection("")).toBe(false);
    });
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// audit 04.cap — CorrectionDetector had NO production caller: the whole class
// was dead, so every natural-language correction ("no, use const instead") was
// dropped on the floor while the tests said the detector worked.
// ─────────────────────────────────────────────────────────────────────────────
describe("the correction detector is on the real path (audit 04.cap)", () => {
  const orchestrator = readFileSync("src/agents/orchestrator.ts", "utf8");

  it("the orchestrator's message path consults the detector", () => {
    expect(orchestrator, "CorrectionDetector is still unreferenced in production").toContain(
      "CorrectionDetector",
    );
    expect(orchestrator).toContain("CorrectionDetector.isCorrection(text)");
  });

  it("a detected correction is routed into the learning pipeline", () => {
    const at = orchestrator.indexOf("CorrectionDetector.isCorrection(text)");
    expect(at).toBeGreaterThan(0);
    const wiring = orchestrator.slice(at, at + 1200);
    expect(wiring, "the detected correction goes nowhere").toContain("recordCorrection(");
    expect(wiring).toContain("natural_language");
  });

  describe("lastAgentText — a correction is about a previous agent turn", () => {
    it("returns the most recent assistant text", () => {
      expect(
        CorrectionDetector.lastAgentText([
          { role: "user", content: "write the board" },
          { role: "assistant", content: "I used a raw delegate for the callback." },
          { role: "user", content: "no, use UnityEvent instead" },
        ]),
      ).toBe("I used a raw delegate for the callback.");
    });

    it("joins the text blocks of a structured assistant message", () => {
      expect(
        CorrectionDetector.lastAgentText([
          {
            role: "assistant",
            content: [
              { type: "text", text: "Wrote Board.cs" },
              { type: "image", source: {} },
              { type: "text", text: "and Player.cs" },
            ],
          },
        ]),
      ).toBe("Wrote Board.cs and Player.cs");
    });

    it("returns null when the agent has not spoken yet — nothing is being corrected", () => {
      expect(CorrectionDetector.lastAgentText([{ role: "user", content: "no, that is wrong" }])).toBeNull();
      expect(CorrectionDetector.lastAgentText([])).toBeNull();
    });

    it("returns null when the last assistant turn carries no text (tool calls only)", () => {
      expect(
        CorrectionDetector.lastAgentText([
          { role: "assistant", content: [{ type: "tool_use", id: "t1" }] },
        ]),
      ).toBeNull();
    });
  });
});
