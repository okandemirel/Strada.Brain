import { describe, expect, it } from "vitest";
import { windowGdd, GDD_AUDIT_FULL_CHARS } from "./campaign-planner.js";

const HEAD = 50_000;
const TAIL = 30_000;

function bigGdd(middleLine: string, totalMiddle = 120_000): string {
  const head = "H".repeat(HEAD);
  const tail = "T".repeat(TAIL);
  const lines = Math.ceil(totalMiddle / (middleLine.length + 1));
  const middle = Array.from({ length: lines }, () => middleLine).join("\n");
  return `${head}\n${middle}\n${tail}`;
}

describe("windowGdd", () => {
  it("passes small documents through untouched", () => {
    const text = "# GDD\nsmall document";
    expect(windowGdd(text)).toBe(text);
  });

  it("keeps bullet and numbered schedule lines from the middle (not only headings/tables)", () => {
    const doc = bigGdd("- Bomb: 3x3 blast, spawns from 4-match");
    const windowed = windowGdd(doc);
    expect(windowed).toContain("- Bomb: 3x3 blast");
    expect(windowed.length).toBeLessThan(doc.length);
  });

  it("samples a structure-less middle instead of pretending an outline exists", () => {
    // Converted .docx/.pdf: bare prose lines, no markdown markers at all.
    const doc = bigGdd(
      "the bomb element explodes in a three by three blast when four tiles are matched together somewhere",
    );
    const windowed = windowGdd(doc);
    expect(windowed).toContain("no markdown structure");
    // Samples from deep in the middle actually appear.
    expect(windowed).toContain("three by three blast");
  });

  it("audit-sized window passes a 300k document through whole", () => {
    const doc = "x".repeat(300_000);
    expect(windowGdd(doc, GDD_AUDIT_FULL_CHARS)).toBe(doc);
  });
});
