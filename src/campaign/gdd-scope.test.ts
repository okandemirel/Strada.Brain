/**
 * The GDD's measured scope sizes the ladder and is the inventory a plan is
 * held against — until 2026-09-10 every game got "2 to 12 milestones".
 */
import { describe, expect, it } from "vitest";
import { extractHeadings, measureGddScope, normalizeHeading, uncoveredSections } from "./gdd-scope.js";

const BIG = `# Sky Pigs
## Table of Contents
## 1. Overview
## 2. Core Loop
### 2.1 Merging
## 3. Element schedule
| Unlock | Element | Notes |
|---|---|---|
| L1 | Cube | basic |
| L2 | Sphere | rolls |
| L3 | Pyramid | sharp |
| L4 | Torus | ring |
| L5 | Prism | light |
| L6 | Cone | |
| L7 | Dragon Boss | set piece |
| L8 | Ice Block | |
| L9 | Lava | |
## 4. Levels
There are 100 levels across four worlds.
## 5. Screens
Main menu, level select, pause menu, results screen and a HUD.
## 6. Audio
Music base loop per area; SFX for tap, merge and win.
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
    expect(h[0]).toBe("Sky Pigs");
    expect(h).toContain("2. Core Loop");
    expect(h).toContain("2.1 Merging");
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
