/**
 * The GDD's measured scope sizes the ladder and is the inventory a plan is
 * held against — until 2026-09-10 every game got "2 to 12 milestones".
 */
import { describe, expect, it } from "vitest";
import {
  extractHeadings,
  headingClaimedBy,
  measureGddScope,
  normalizeHeading,
  TRIVIAL_HEADING_RE,
  uncoveredSections,
  WORK_DEMAND_RE,
} from "./gdd-scope.js";

const BIG = `# Orchard Seasons
## Table of Contents
## 1. Overview
## 2. Core Loop
### 2.1 Grafting
## 3. Feature unlocks
| Unlock | Feature | Notes |
|---|---|---|
| L1 | Pruning | basic |
| L2 | Grafting | two trees |
| L3 | Irrigation | channels |
| L4 | Beehive | pollination |
| L5 | Compost | soil |
| L6 | Cold Frame | |
| L7 | Frost Night | seasonal event |
| L8 | Cider Press | |
| L9 | Hail Storm | |
## 4. Levels
There are 100 levels across four orchards.
## 5. Screens
Main menu, level select, pause menu, results screen and a HUD.
## 6. Audio
Music: one calm loop per season; SFX for pruning, grafting and harvest.
## 7. Progression and saving
Progress is saved to the cloud; a tutorial (FTUE) runs on first launch. Settings screen has accessibility toggles.
## 8. Performance
Target 60 fps; loads in under 3 seconds. Android APK and iOS.
## Appendix A
## Glossary
`;

describe("extractHeadings", () => {
  it("keeps section headings in order and drops document apparatus", () => {
    const h = extractHeadings(BIG);
    expect(h[0]).toBe("Orchard Seasons");
    expect(h).toContain("2. Core Loop");
    expect(h).toContain("2.1 Grafting");
    expect(h).toContain("8. Performance");
    expect(h).not.toContain("Table of Contents");
    expect(h).not.toContain("Appendix A");
    expect(h).not.toContain("Glossary");
  });

  it("reads numbered plain-text section lines from a converted document", () => {
    expect(extractHeadings("3. Core Loop\nThe player merges.\n3.2 Scoring\nPoints per merge.\nnot a heading\n")).toEqual(["Core Loop", "Scoring"]);
  });
});

describe("measureGddScope", () => {
  it("counts elements, levels, screens and asks, and sizes the ladder from them", () => {
    const s = measureGddScope(BIG);
    expect(s.elements).toBe(9);
    expect(s.levels).toBe(100);
    expect(s.screens).toBeGreaterThanOrEqual(4);
    expect(s.asks).toMatchObject({ audio: true, save: true, onboarding: true, settings: true, performance: true, build: true, ui: true });
    // 2 + ceil(9/4)=3 + ceil(100/25)=4 + ui 1 + audio 1 + save/ftue/settings 1 = 12 → 11..15
    expect([s.minMilestones, s.maxMilestones]).toEqual([11, 15]);
  });

  it("a one-mechanic prototype gets a small ladder, never the same range as an epic", () => {
    const s = measureGddScope("# Tap\n## Core loop\nTap the square before it fades.\n## Win\nSurvive 30 seconds.\n");
    expect(s.elements).toBe(0);
    expect(s.levels).toBeUndefined();
    expect(s.asks.audio).toBe(false);
    expect([s.minMilestones, s.maxMilestones]).toEqual([3, 6]);
  });
});

describe("uncoveredSections", () => {
  it("a claim covers a heading when either contains the other, normalized; short claims cover nothing", () => {
    const headings = ["2. Core Loop", "2.1 Merging", "6. Audio", "8. Performance"];
    expect(uncoveredSections(headings, ["Core Loop — merging", "audio", "UI"])).toEqual(["8. Performance"]);
    expect(uncoveredSections(headings, ["2.", "x"])).toEqual(headings);
    expect(normalizeHeading("  3.2  Scoring & Combos! ")).toBe("scoring combos");
  });
});

describe("a design document's FRONT MATTER is not build work (measured live 2026-09-12)", () => {
  it("leaves the introduction, the summary and the market section out of the ladder", () => {
    // The live campaign's first milestone was "INTRODUCTION": the mechanical
    // grouping turned the GDD's front matter into sprints, and a worker was
    // asked to build an introduction. Apparatus was filtered by a list that
    // named contents and glossaries but not the sections every design document
    // opens with.
    const gdd = [
      "1. Introduction",
      "1.1 Summary",
      "1.2 Competitive Analysis",
      "1.3 Terminology",
      "1.4 About This Document",
      "1.5 Glossary",
      "2. HOW A SEASON PLAYS",
      "3. RULES OF THE ORCHARD",
      "8. RELEASE STEPS",
    ].join("\n");

    const headings = extractHeadings(gdd);

    expect(headings).toEqual(["HOW A SEASON PLAYS", "RULES OF THE ORCHARD", "RELEASE STEPS"].map((h) => expect.stringContaining(h)));
  });

  it("keeps a section whose name only LOOKS like apparatus but names work", () => {
    const headings = extractHeadings([
      "2. Scope of the Map Editor",
      "4. Reference Art Pipeline",
      "5. Introduction Cinematic",
    ].join("\n"));

    expect(headings).toHaveLength(3);
  });

  it("an apparatus NAME over a section that asks for work is work (Codex 2026-09-12 P#13)", () => {
    // The denylist dropped these outright, so the requirements vanished from
    // the ladder — a credits screen nobody built, a cinematic nobody played.
    expect(extractHeadings([
      "## Credits",
      "Build an interactive credits screen.",
      "## Introduction",
      "Play an opening cinematic.",
    ].join("\n"))).toEqual(["Credits", "Introduction"]);

    // …while a section that DESCRIBES is still apparatus.
    expect(extractHeadings([
      "## Introduction",
      "This document describes the design of Grid Quest.",
      "## Core Loop",
      "Merge frogs.",
    ].join("\n"))).toEqual(["Core Loop"]);

    // A section's own body decides, not the NEXT section's: without the
    // boundary, apparatus inherits the work below it.
    expect(extractHeadings(["## Glossary", "Terms used in this document.", "## Orchard Map", "Build the grid."].join("\n")))
      .toEqual(["Orchard Map"]);

    // An obligation counts as an ask.
    expect(extractHeadings(["## Scope", "The game must support 500 levels.", "## Core", "Rules."].join("\n")))
      .toEqual(["Scope", "Core"]);
  });

  it("the numbering is stripped as a token, not as characters (Codex 2026-09-12 P#13)", () => {
    expect(normalizeHeading("1. INTRODUCTION")).toBe("introduction");
    // Lowercasing first left the Roman numeral in place, so this slipped past
    // every apparatus rule…
    expect(normalizeHeading("I. Introduction")).toBe("introduction");
    // …and a character class that merely listed the numerals ate the leading
    // "I" of the word itself.
    expect(normalizeHeading("Introduction")).toBe("introduction");
    expect(normalizeHeading("iOS Build")).toBe("ios build");
    expect(normalizeHeading("3.2 Scoring & Combos")).toBe("scoring combos");
  });
});

describe("headingClaimedBy — one containment rule for coverage and for row ownership (W04)", () => {
  it("claims a heading when either side contains the other, normalized; a short claim claims nothing", () => {
    expect(headingClaimedBy("4.2 Grafting rules (G-01 … G-09)", ["Grafting rules"])).toBe(true);
    expect(headingClaimedBy("Core Loop", ["2. Core Loop — merging"])).toBe(true);
    expect(headingClaimedBy("Performance", ["Audio", "UI"])).toBe(false);
    expect(headingClaimedBy("UI", ["UI"])).toBe(false);
    // uncoveredSections is the same rule, negated.
    const headings = ["2. Core Loop", "6. Audio", "8. Performance"];
    const claims = ["Core Loop — merging", "audio"];
    expect(uncoveredSections(headings, claims)).toEqual(headings.filter((h) => !headingClaimedBy(h, claims)));
  });

  it("exports the apparatus and work-demand rules the row extractor shares", () => {
    expect(TRIVIAL_HEADING_RE.test(normalizeHeading("9. Revision History"))).toBe(true);
    expect(TRIVIAL_HEADING_RE.test(normalizeHeading("2.1 Season Phases"))).toBe(false);
    // A market heading that names its comparison titles is still front matter.
    expect(TRIVIAL_HEADING_RE.test(normalizeHeading("1.2 Market Analysis & Comparable Titles"))).toBe(true);
    expect(WORK_DEMAND_RE.test("Build an interactive credits screen.")).toBe(true);
    expect(WORK_DEMAND_RE.test("This document describes the game.")).toBe(false);
  });
});

describe("a numbered heading may open with any capital letter, not only A-Z (W04)", () => {
  it("reads Turkish, German, French and Spanish section lines from a converted document", () => {
    expect(extractHeadings([
      "3.2 Çekirdek Kurallar",
      "Oyuncu bir tohuma dokunur.",
      "4. Übersicht der Elemente",
      "Text.",
      "5. Écrans",
      "Texte.",
      "6. Ámbito del juego",
      "Texto.",
    ].join("\n"))).toEqual(["Çekirdek Kurallar", "Übersicht der Elemente", "Écrans", "Ámbito del juego"]);
  });
});
