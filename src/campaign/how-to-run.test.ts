import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractCoreLoop, readUnityVersion, renderHowToRun } from "./how-to-run.js";

/**
 * The person who opened the delivered PixelFlow tree (2026-09-03) had 20
 * scenes, no README, and no idea what the game's verb was. Everything this
 * file writes must be MEASURED — the Unity version off ProjectVersion.txt,
 * the entry scene off Build Settings, the suite off the milestone's own
 * verdict, the verb off the GDD — and anything unmeasured must say so.
 */
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "howto-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The real GDD's shape: a flattened table row, its label alone on one line. */
const REAL_GDD = [
  "TABLE OF CONTENTS",
  "1. INTRODUCTION",
  "1.1 Executive Summary",
  "Field",
  "Value",
  "Genre",
  "Casual Puzzle — “Sorting Shooter / Color Shooter” sub-genre",
  "Core mechanic",
  "Tap a pig on the conveyor to send it to a tray slot, where it auto-fires balls at exposed pixel cubes of its own color until its ammo runs out. Clear 100% of the pixel-art canvas without deadlocking the 5-slot tray.",
  "Session length",
  "Levels of 1–4 minutes",
  "",
  "12. PRODUCTION",
  "Core loop fun-test: 20 graybox levels, feel budget met (≤50 ms), team plays it unprompted",
].join("\n");

describe("core-loop extraction", () => {
  it("takes the labelled field's value, not a heading and not a look-alike line", () => {
    const loop = extractCoreLoop(REAL_GDD);
    expect(loop).toContain("Tap a pig on the conveyor");
    expect(loop).toContain("without deadlocking the 5-slot tray");
    // "Core loop fun-test: ..." is a different field; matching it would put a
    // production checklist in the play instructions.
    expect(loop).not.toContain("graybox");
  });

  it("reads the inline `Core loop: ...` form too", () => {
    expect(extractCoreLoop("# Design\n\n**Core loop:** Stack the blocks, clear the line.\n")).toBe(
      "Stack the blocks, clear the line.",
    );
  });

  it("returns nothing when the GDD names no core-mechanic field — it never guesses", () => {
    expect(extractCoreLoop("# Game\n\nIt is a game about pigs.\n\n## Levels\n\nThere are many.")).toBeUndefined();
  });

  it("does not take a heading as the value of a bare label", () => {
    expect(extractCoreLoop("Core mechanic\n\n## 2. SIMULATION\n\nThe sim runs at 60hz.")).toBeUndefined();
  });
});

describe("unity version", () => {
  it("reads the editor version off ProjectVersion.txt", () => {
    const root = tmp();
    mkdirSync(join(root, "ProjectSettings"), { recursive: true });
    writeFileSync(
      join(root, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 6000.3.22f1\nm_EditorVersionWithRevision: 6000.3.22f1 (1c726e1fb402)\n",
    );
    expect(readUnityVersion(root)).toEqual({ version: "6000.3.22f1" });
  });

  it("says why it is unknown rather than inventing one", () => {
    const result = readUnityVersion(tmp());
    expect(result.version).toBeUndefined();
    expect(result.note).toContain("ProjectVersion.txt");
  });
});

describe("HOW_TO_RUN.md rendering", () => {
  const measured = {
    projectRoot: "/tmp/PixelFlow-Clean",
    unityVersion: "6000.3.22f1",
    entryScene: "Assets/Scenes/ProductionMain.unity",
    entryObjects: 17,
    scaffolding: ["Assets/Scenes/UfoShowcase.unity", "Assets/Scenes/AssembledMain.unity"],
    unclassified: ["Assets/Scenes/Main.unity"],
    otherEnabled: 13,
    coreLoop: "Tap a pig on the conveyor to send it to a tray slot.",
    gddPath: "docs/PixelFlow_GDD.md",
    suiteVerdict: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)",
    suiteUnfiltered: true,
    testPlatform: "PlayMode",
  };

  it("writes only measured facts, each attributed to what measured it", () => {
    const text = renderHowToRun(measured);

    expect(text).toContain("6000.3.22f1");
    expect(text).toContain("ProjectSettings/ProjectVersion.txt");
    expect(text).toContain("Assets/Scenes/ProductionMain.unity");
    expect(text).toContain("EditorBuildSettings.asset");
    expect(text).toContain("Tap a pig on the conveyor");
    expect(text).toContain("docs/PixelFlow_GDD.md");
    expect(text).toContain("179 of 179");
    expect(text).toContain("-testPlatform PlayMode");
    // The scaffolding list is the "what can be removed" section.
    expect(text).toContain("UfoShowcase.unity");
    expect(text).toContain("AssembledMain.unity");
    // An unclassified scene is listed, and explicitly NOT called removable.
    expect(text).toContain("Main.unity");
    expect(text).toContain("not classified as scaffolding");
    expect(text).not.toContain("Unknown");
  });

  it("says Unknown, with the reason, for every field nothing measured", () => {
    const text = renderHowToRun({
      projectRoot: "/tmp/Empty",
      unityVersionNote: "ProjectSettings/ProjectVersion.txt could not be read (not found)",
      entryNote: "ProjectSettings/EditorBuildSettings.asset could not be read (not found)",
      coreLoopNote: "no GDD path was recorded for this campaign",
      suiteNote: "the final sprint recorded no test verdict",
      scaffolding: [],
      unclassified: [],
      otherEnabled: 0,
    });

    expect(text).toContain("Unknown — ProjectSettings/ProjectVersion.txt could not be read");
    expect(text).toContain("Unknown — ProjectSettings/EditorBuildSettings.asset could not be read");
    expect(text).toContain("Unknown — no GDD path was recorded");
    expect(text).toContain("Unknown — the final sprint recorded no test verdict");
    // Nothing invented: no scene name, no version, no verb.
    expect(text).not.toContain(".unity");
    expect(text).not.toMatch(/\d{4}\.\d\.\d+f\d/);
  });

  it("does not claim the suite is the whole suite when the green was filtered", () => {
    const text = renderHowToRun({
      ...measured,
      suiteVerdict: "42 of 42 tests passed",
      suiteUnfiltered: false,
    });
    expect(text).toContain("FILTERED");
    expect(text).not.toContain("the whole suite was seen to pass");
  });

  it("does not invent a test platform the verdict never named", () => {
    const text = renderHowToRun({ ...measured, testPlatform: undefined });
    expect(text).toContain("-testPlatform");
    expect(text).toContain("the recorded verdict does not name which suite ran");
  });
});
