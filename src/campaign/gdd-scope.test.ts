/**
 * The GDD's measured scope sizes the ladder and is the inventory a plan is
 * held against — until 2026-09-10 every game got "2 to 12 milestones".
 */
import { describe, expect, it } from "vitest";
import {
  entryScreenInDocument,
  extractHeadings,
  headingClaimedBy,
  measureGddScope,
  normalizeHeading,
  TRIVIAL_HEADING_RE,
  uncoveredSections,
  WORK_DEMAND_RE,
} from "./gdd-scope.js";

const BIG = `# Orchard Seasons
## Contents
## 1. Planning Phase
### 1.1 Pruning Orders
## 2. Sound
A wind-and-birdsong soundtrack plays under every season.
## 3. Varieties by Year
| Year | Variety | Note |
|---|---|---|
| Y1 | Russet Pear | hardy |
| Y2 | Quince | |
| Y3 | Medlar | late |
| Y4 | Damson | |
| Y5 | Greengage | |
| Y6 | Bramley | cooking |
| Y7 | Morello | shade |
## 4. Saving and Options
The journal is saved to the season slot after each harvest. An onboarding season walks the player through pruning. An options menu sets text size.
## 5. Load Times and Stores
The season map loads in under 4 seconds. Ships to Steam and the App Store.
## 6. Orchard Map
The orchard is a walled grid of plots.
## 7. Campaign
The campaign runs 53 levels, one per season.
## 8. Screens
An orchard map screen, an inventory screen, a leaderboard and a pause menu.
## Credits
## Appendix C
`;

describe("extractHeadings", () => {
  it("keeps section headings in order and drops document apparatus", () => {
    const h = extractHeadings(BIG);
    expect(h[0]).toBe("Orchard Seasons");
    expect(h).toContain("1. Planning Phase");
    expect(h).toContain("1.1 Pruning Orders");
    expect(h).toContain("5. Load Times and Stores");
    expect(h).not.toContain("Contents");
    expect(h).not.toContain("Credits");
    expect(h).not.toContain("Appendix C");
  });

  it("reads numbered plain-text section lines from a converted document", () => {
    expect(extractHeadings("3. Core Loop\nThe player merges.\n3.2 Scoring\nPoints per merge.\nnot a heading\n")).toEqual(["Core Loop", "Scoring"]);
  });
});

describe("measureGddScope", () => {
  it("counts elements, levels, screens and asks, and sizes the ladder from them", () => {
    const s = measureGddScope(BIG);
    expect(s.elements).toBe(7);
    expect(s.levels).toBe(53);
    expect(s.screens).toBeGreaterThanOrEqual(4);
    expect(s.asks).toMatchObject({ audio: true, save: true, onboarding: true, settings: true, performance: true, build: true, ui: true });
    // 2 + ceil(7/4)=2 + ceil(53/25)=3 + ui 1 + audio 1 + save/onboarding/settings 1 = 10 → 9..13
    expect([s.minMilestones, s.maxMilestones]).toEqual([9, 13]);
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
  it("leaves the introduction, the summary and a competitor section out of the ladder", () => {
    // The live campaign's first milestone was "INTRODUCTION": the mechanical
    // grouping turned the GDD's front matter into sprints, and a worker was
    // asked to build an introduction. Apparatus was filtered by a list that
    // named contents and glossaries but not the sections every design document
    // opens with.
    const gdd = [
      "## Introduction",
      "## Pruning Orders",
      "## Summary",
      "## Harvest Weighing",
      "## Competitive Analysis",
    ].join("\n");

    const headings = extractHeadings(gdd);

    expect(headings).toEqual(["Pruning Orders", "Harvest Weighing"]);
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
      "This document describes the design of the orchard.",
      "## Core Loop",
      "Prune the trees.",
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
    expect(headingClaimedBy("7. Grafting rules for walled plots", ["Grafting rules"])).toBe(true);
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
    // A market-analysis heading is front matter too.
    expect(TRIVIAL_HEADING_RE.test(normalizeHeading("Market Analysis"))).toBe(true);
    expect(WORK_DEMAND_RE.test("Build an interactive credits screen.")).toBe(true);
    expect(WORK_DEMAND_RE.test("This document describes the game.")).toBe(false);
  });

  it("reads a heading JOINED out of apparatus terms, whichever terms a document joins", () => {
    // One compound was spelled out for one document's front matter, so every
    // other joining of the same apparatus words came back as build work.
    for (const apparatus of [
      "Glossary & References",
      "Credits and Acknowledgements",
      "Competitive Analysis & Comparable Titles",
      "Purpose, Scope and Terminology",
      "Revision History & Approvals",
    ]) {
      expect({ apparatus, trivial: TRIVIAL_HEADING_RE.test(normalizeHeading(apparatus)) })
        .toEqual({ apparatus, trivial: true });
    }
    // …while a heading that merely CONTAINS an apparatus word is work, joined
    // or not: only a heading made ENTIRELY of apparatus terms is dropped.
    for (const work of [
      "Market Stall Haggling",
      "Scope of the Map Editor",
      "Glossary Terminal and Lore Codex",
      "Credits Cinematic & Dedication Wall",
      "Index Finger Gestures",
    ]) {
      expect({ work, trivial: TRIVIAL_HEADING_RE.test(normalizeHeading(work)) })
        .toEqual({ work, trivial: false });
    }
  });
});

describe("a numbered heading may open with any capital letter, not only A-Z (W04)", () => {
  it("reads Turkish, German, French and Spanish section lines from a converted document", () => {
    expect(extractHeadings([
      "3.2 Çiçeklenme Takvimi",
      "Ağaçlar sırayla çiçek açar.",
      "4. Übersicht der Obstsorten",
      "Text.",
      "5. Écrans",
      "Texte.",
      "6. Ámbito del juego",
      "Texto.",
    ].join("\n"))).toEqual(["Çiçeklenme Takvimi", "Übersicht der Obstsorten", "Écrans", "Ámbito del juego"]);
  });
});

/**
 * The screen a document says the game OPENS ON. The system told every final
 * sprint to make the entry scene play by itself; a document may name a menu,
 * a lobby or a hub instead, and what must then be proven is the ROUTE from
 * that screen into play (Codex 2026-09-12 V, Job 3.9).
 *
 * Generic wording only: the reader is held against invented documents here, so
 * no one game's boot sentence is the only one it can read.
 */
describe("entryScreenInDocument — the screen the document opens on", () => {
  it("names the screen a boot sentence routes to, whatever the verb and preposition", () => {
    expect(entryScreenInDocument("The app launches into the lobby.")).toBe("lobby");
    expect(entryScreenInDocument("Sousaphone Rally boots to the main menu, never straight into a parade.")).toBe("main menu");
    expect(entryScreenInDocument("After a crash the game resumes at the hub.")).toBe("hub");
    // A cold launch is read by the same verb, with no prefix of its own.
    expect(entryScreenInDocument("A cold launch opens on the dashboard.")).toBe("dashboard");
  });

  it("falls back to a sentence that names the first screen without a boot verb", () => {
    expect(entryScreenInDocument("The title screen is the first screen a visitor sees.")).toBe("title screen");
    expect(entryScreenInDocument("The lobby is the landing view for every returning diver.")).toBe("lobby");
  });

  it("names nothing when the document never says where the game opens", () => {
    expect(entryScreenInDocument("The crane starts at dawn on the pier.")).toBeUndefined();
    expect(entryScreenInDocument("A parade lap lasts four minutes.")).toBeUndefined();
    expect(entryScreenInDocument(undefined)).toBeUndefined();
  });
});
