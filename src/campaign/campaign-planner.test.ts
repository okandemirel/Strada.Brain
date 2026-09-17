import { describe, expect, it } from "vitest";
import { windowGdd, GDD_AUDIT_FULL_CHARS, quoteIsAbout, requirementTokens } from "./campaign-planner.js";

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

  it("past 400k the audit window is genuinely larger than the planner's (slices scale with the threshold)", () => {
    // Audited 2026-09-02: fullThreshold gated only the early return; the
    // head/tail/outline slices were module constants, so a 600k GDD gave the
    // audit byte-for-byte the planner's window — exactly the blind spot the
    // audit exists to catch.
    const doc = bigGdd("- Bomb: 3x3 blast, spawns from 4-match", 520_000);
    expect(doc.length).toBeGreaterThan(GDD_AUDIT_FULL_CHARS);
    const planner = windowGdd(doc);
    const audit = windowGdd(doc, GDD_AUDIT_FULL_CHARS);
    expect(audit).not.toBe(planner);
    expect(audit.length).toBeGreaterThan(planner.length * 2);
  });

  it("says when the structural outline itself was truncated instead of claiming it follows", () => {
    const doc = bigGdd("- Bomb: 3x3 blast, spawns from 4-match"); // 120k of schedule lines > outline budget
    const windowed = windowGdd(doc);
    expect(windowed).toMatch(/outline truncated to \d+ of \d+ chars/);
  });
});

/** Plan 0-B.3: a measured line is evidence only for a requirement it is about. */
describe("quoteIsAbout", () => {
  it("stems the requirement's distinctive words and drops its verdict suffix", () => {
    expect(requirementTokens("Save progress across restarts: absent")).toEqual(["sav", "progress", "across", "restart"]);
    expect(requirementTokens("Shop: absent")).toEqual(["shop"]);
    // Unicode words are words (round 6 #2).
    expect(requirementTokens("Çıkış menüsü: absent")).toEqual(["çıkış", "menüsü"]);
  });

  it("holds each kind of line to the requirement", () => {
    expect(quoteIsAbout("Save progress across restarts: absent", "landed: Added Assets/Scripts/SaveSystem.cs")).toBe(true);
    expect(quoteIsAbout("Save progress across restarts: absent", "landed: Added Assets/Art/Hero.png")).toBe(false);
    expect(quoteIsAbout("Save progress across restarts: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(false);
    expect(quoteIsAbout("The full test suite runs green: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(true);
    expect(quoteIsAbout("Dragon boss: absent", "shipped tree: Assets/Prefabs/DragonBoss.prefab present")).toBe(true);
    expect(quoteIsAbout("Level count: 13 levels", "document numbers: 13 levels claimed; 13 played to an outcome")).toBe(true);
    expect(quoteIsAbout("Level count: 13 levels", "document numbers: boots in 2.1 s (claimed under 3 s)")).toBe(false);
    // A requirement made only of stopwords cannot be closed by relevance.
    expect(quoteIsAbout("The game: absent", "landed: Added Assets/Game.cs")).toBe(false);
    // Whole stems, not substrings: a screensaver is not the save system, and
    // "saving" is (round 6 #1, #2).
    expect(quoteIsAbout("Save progress across restarts: absent", "landed: Added Assets/Art/ScreenSaver.png")).toBe(false);
    expect(quoteIsAbout("Saving progress: absent", "landed: Added Assets/Scripts/SaveSystem.cs")).toBe(true);
    expect(quoteIsAbout("Level count: 13 levels", "landed: Added Assets/Scripts/Leverage.cs")).toBe(false);
    // A suite total closes the suite requirement, not a requirement that merely mentions a test.
    expect(quoteIsAbout("Test saving progress: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(false);
    expect(quoteIsAbout("All tests pass: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(true);
    // Round 7 #1-#3: canonical stems, generic actions dropped, suite-only rule.
    expect(quoteIsAbout("Progress bar: absent", "landed: Added Assets/UI/Progresses.cs")).toBe(true);
    expect(quoteIsAbout("Mouse input: absent", "landed: Added Assets/Input/Mice.cs")).toBe(true);
    expect(quoteIsAbout("Run offline: absent", "landed: Added Assets/Scripts/RunAnalytics.cs")).toBe(false);
    expect(quoteIsAbout("Set resolution: absent", "landed: Added Assets/Scripts/SetVolume.cs")).toBe(false);
    expect(quoteIsAbout("Set resolution: absent", "landed: Added Assets/Settings/ResolutionMenu.cs")).toBe(true);
    expect(quoteIsAbout("All unit tests cover saving: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(false);
    expect(quoteIsAbout("Tests for saving pass: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(false);
    expect(quoteIsAbout("The whole PlayMode suite runs clean: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(true);
  });
});
