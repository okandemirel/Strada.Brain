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
/** The stem a word gets, read through the exported tokenizer. */
function stemOf(word: string): string {
  return requirementTokens(`${word} thing: absent`)[0]!;
}

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
    // Round 8 #14: a word ending in a double s, -is or -es keeps its identity.
    expect(requirementTokens("Analysis view: absent")).toContain("analysis");
    expect(requirementTokens("Analyses view: absent")).toContain("analysis");
    expect(requirementTokens("Axis labels: absent")).toContain("axis");
    expect(requirementTokens("Axes labels: absent")).toContain("axis");
    expect(quoteIsAbout("Analysis view: absent", "landed: Added Assets/UI/Analyses.cs")).toBe(true);
    expect(quoteIsAbout("Progress bar: absent", "landed: Added Assets/UI/Progress.cs")).toBe(true);
    expect(quoteIsAbout("Process queue: absent", "landed: Added Assets/Scripts/Processes.cs")).toBe(true);
    // Round 9 #33: the -is/-es families are LISTED, so ordinary -xes/-ses
    // plurals still meet their own singular. "boxes" became "boxis" while
    // "box" stayed "box", and real implementation evidence was rejected.
    expect(requirementTokens("Boxes stack: absent")).toContain(stemOf("box"));
    expect(quoteIsAbout("Boxes stack: absent", "landed: Added Assets/Scripts/Box.cs")).toBe(true);
    expect(quoteIsAbout("Box stacking: absent", "landed: Added Assets/Scripts/Boxes.cs")).toBe(true);
    expect(quoteIsAbout("Houses on the map: absent", "landed: Added Assets/Prefabs/House.prefab present")).toBe(true);
    expect(quoteIsAbout("Lens flares: absent", "landed: Added Assets/Art/Lens.cs")).toBe(true);
    // …and the listed families still hold, including the -ices ones.
    expect(requirementTokens("Matrices view: absent")).toContain("matrix");
    expect(requirementTokens("Vertices count: absent")).toContain("vertex");
    expect(quoteIsAbout("Matrix math: absent", "landed: Added Assets/Scripts/Matrices.cs")).toBe(true);

    // Round 9 #34: ordinary formulations, not a phrase list. Each of these
    // returned false because a word ("başarılı", "réussir", "pasar") was not
    // in the whitelist, so a green suite could not close the requirement.
    expect(quoteIsAbout("Tüm testler başarılı olmalı: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(true);
    expect(quoteIsAbout("Tous les tests doivent réussir: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(true);
    expect(quoteIsAbout("Todas las pruebas deben pasar: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(true);
    expect(quoteIsAbout("Alle Tests müssen bestehen: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(true);
    expect(quoteIsAbout("The entire suite must succeed: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(true);
    // …and a requirement that names a FEATURE is still not closed by a total,
    // in any of those languages (the guard the round 7 rule exists for).
    expect(quoteIsAbout("Tüm testler kaydetmeyi kapsamalı: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(false);
    expect(quoteIsAbout("Les tests de sauvegarde doivent réussir: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(false);
    expect(quoteIsAbout("Todas las pruebas de guardado deben pasar: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(false);

    // Round 10 #17: a FEATURE name that merely starts like a suite word is not
    // a suite predicate. "password" starts with "pass" and "allocation" with
    // "all", so an unrelated green total closed both requirements.
    expect(quoteIsAbout("Test passwords: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(false);
    expect(quoteIsAbout("All allocation tests pass: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(false);
    expect(quoteIsAbout("Tests for the passenger list pass: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(false);

    // Round 8 #15: a suite requirement in another language closes on a suite total.
    expect(quoteIsAbout("Tüm testler geçmeli: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(true);
    expect(quoteIsAbout("Alle Tests bestehen: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(true);
    // …and a feature requirement in another language still does not.
    expect(quoteIsAbout("Kayıt sistemi testleri: absent", "suite: 179/179 tests passed (unfiltered)")).toBe(false);
  });
});
