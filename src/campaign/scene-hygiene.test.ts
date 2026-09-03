import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { assessSceneHygiene, renderSceneHygiene } from "./scene-hygiene.js";

/**
 * Measured on the delivered PixelFlow tree 2026-09-03: 14 scenes enabled in
 * Build Settings, and the person who opened it could not tell which one is
 * the game. These fixtures carry that tree's REAL shape — every enabled path
 * and its real GameObject count, read off
 * /Users/okan/Documents/MaxedOutEntertainment/PixelFlow-Clean.
 */
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "hygiene-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sceneText(objects: number): string {
  return Array.from({ length: objects }, () => "GameObject:\n  m_Name: X").join("\n");
}

/** Writes a project whose build settings enable exactly these scenes. */
function project(scenes: ReadonlyArray<[string, number]>, disabled: readonly string[] = []): string {
  const root = tmp();
  mkdirSync(join(root, "ProjectSettings"), { recursive: true });
  const lines: string[] = ["%YAML 1.1", "EditorBuildSettings:", "  m_Scenes:"];
  for (const [rel, objects] of scenes) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, sceneText(objects));
    lines.push("  - enabled: 1", `    path: ${rel}`, "    guid: 0000");
  }
  for (const rel of disabled) lines.push("  - enabled: 0", `    path: ${rel}`, "    guid: 0000");
  writeFileSync(join(root, "ProjectSettings", "EditorBuildSettings.asset"), lines.join("\n"));
  return root;
}

/** The delivered tree, measured 2026-09-03 (path, GameObject count). */
const REAL_DELIVERY: ReadonlyArray<[string, number]> = [
  ["Assets/Scenes/Gameplay.unity", 3],
  ["Assets/Scenes/Main.unity", 6],
  ["Assets/Scenes/UfoShowcase.unity", 5],
  ["Assets/Scenes/AssembledGame.unity", 2],
  ["Assets/Scenes/ModuleBoundary.unity", 3],
  ["Assets/InitTestScene4abd18f9-8be4-4a53-81df-6a2e7a8dfc19.unity", 5],
  ["Assets/Scenes/LiveOpsAssembled.unity", 3],
  ["Assets/Scenes/AssembledMain.unity", 3],
  ["Assets/Scenes/AssembledUfoRuntime.unity", 3],
  ["Assets/Modules/LiveOpsModule/Scenes/LiveOpsVisualAssembly.unity", 1],
  ["Assets/Scenes/LiveOpsVisualsVerified.unity", 3],
  ["Assets/Scenes/LiveOpsPresentation.unity", 4],
  ["Assets/Scenes/TargetedLevel151Verification.unity", 5],
  ["Assets/Scenes/ProductionMain.unity", 17],
];

describe("scene hygiene — the real delivered shape", () => {
  it("names the entry scene and discloses every other enabled scene", () => {
    const report = assessSceneHygiene(project(REAL_DELIVERY));

    expect(report.refusal).toBeUndefined();
    expect(report.enabled).toHaveLength(14);
    expect(report.entry?.path).toBe("Assets/Scenes/ProductionMain.unity");
    expect(report.entry?.objects).toBe(17);
    // 13 enabled scenes are NOT the entry point — the whole of the user's
    // "which one is the game?".
    expect(report.otherEnabled).toBe(13);
    // Of those 13, these match scaffolding shape (name, or fewer than 3
    // GameObjects). Gameplay(3), Main(6) and LiveOpsPresentation(4) match
    // neither rule and are disclosed as unclassified, never as scaffolding.
    expect(report.scaffolding.map((s) => s.path).sort()).toEqual(
      [
        "Assets/InitTestScene4abd18f9-8be4-4a53-81df-6a2e7a8dfc19.unity",
        "Assets/Modules/LiveOpsModule/Scenes/LiveOpsVisualAssembly.unity",
        "Assets/Scenes/AssembledGame.unity",
        "Assets/Scenes/AssembledMain.unity",
        "Assets/Scenes/AssembledUfoRuntime.unity",
        "Assets/Scenes/LiveOpsAssembled.unity",
        "Assets/Scenes/LiveOpsVisualsVerified.unity",
        "Assets/Scenes/ModuleBoundary.unity",
        "Assets/Scenes/TargetedLevel151Verification.unity",
        "Assets/Scenes/UfoShowcase.unity",
      ].sort(),
    );
    expect(report.unclassified.map((s) => s.path).sort()).toEqual([
      "Assets/Scenes/Gameplay.unity",
      "Assets/Scenes/LiveOpsPresentation.unity",
      "Assets/Scenes/Main.unity",
    ]);

    const text = renderSceneHygiene(report);
    expect(text).toContain("Assets/Scenes/ProductionMain.unity");
    expect(text).toContain("17 objects");
    expect(text).toContain("13 other scenes are enabled");
    expect(text).toContain("10 of them");
    expect(text).toContain("verification scaffolding");
    // A count with no names is not a disclosure a person can act on.
    expect(text).toContain("TargetedLevel151Verification.unity");
    // The three that match neither rule are named too — silence about them
    // would read as "the other 13 are all disposable".
    expect(text).toContain("3 match neither");
  });
});

describe("scene hygiene — clean and broken builds", () => {
  it("discloses nothing extra when one scene is enabled and it is the game", () => {
    const report = assessSceneHygiene(project([["Assets/Scenes/Main.unity", 12]]));

    expect(report.refusal).toBeUndefined();
    expect(report.entry?.path).toBe("Assets/Scenes/Main.unity");
    expect(report.otherEnabled).toBe(0);
    expect(report.scaffolding).toHaveLength(0);
    const text = renderSceneHygiene(report);
    expect(text).toContain("Assets/Scenes/Main.unity");
    expect(text).not.toContain("scaffolding");
    expect(text).not.toContain("other scenes are enabled");
  });

  it("refuses when the build has no enabled scene at all", () => {
    const report = assessSceneHygiene(project([], ["Assets/Scenes/Main.unity"]));

    expect(report.refusal?.kind).toBe("no-enabled-scene");
    expect(report.refusal?.detail).toContain("no scene is enabled");
    expect(report.entry).toBeUndefined();
  });

  it("refuses when no enabled scene can be read, so no entry can be named", () => {
    const root = project([["Assets/Scenes/Ghost.unity", 4]]);
    rmSync(join(root, "Assets", "Scenes", "Ghost.unity"));

    const report = assessSceneHygiene(root);
    expect(report.refusal?.kind).toBe("entry-unidentifiable");
    expect(report.unreadable).toEqual(["Assets/Scenes/Ghost.unity"]);
  });

  it("refuses when every enabled scene is empty — there is nothing to open", () => {
    const report = assessSceneHygiene(project([["Assets/Scenes/Empty.unity", 0]]));
    expect(report.refusal?.kind).toBe("entry-unidentifiable");
    expect(report.refusal?.detail).toContain("0 GameObjects");
  });

  it("does not refuse when build settings cannot be measured — it says so", () => {
    const report = assessSceneHygiene(tmp());

    expect(report.measurable).toBe(false);
    expect(report.refusal).toBeUndefined();
    expect(report.note).toContain("EditorBuildSettings.asset");
    expect(renderSceneHygiene(report)).toContain("could not be measured");
  });

  it("names one entry deterministically when two scenes tie, and says they tie", () => {
    const report = assessSceneHygiene(
      project([["Assets/Scenes/B.unity", 9], ["Assets/Scenes/A.unity", 9]]),
    );

    expect(report.refusal).toBeUndefined();
    expect(report.entry?.path).toBe("Assets/Scenes/A.unity");
    expect(report.entryTied).toEqual(["Assets/Scenes/B.unity"]);
    expect(renderSceneHygiene(report)).toContain("tie");
  });

  it("reads a scene path containing spaces", () => {
    const report = assessSceneHygiene(project([["Assets/Scenes/My Game.unity", 8]]));
    expect(report.entry?.path).toBe("Assets/Scenes/My Game.unity");
  });
});

describe("scene hygiene fixture integrity", () => {
  it("writes the object counts the assessment reads back", () => {
    const root = project([["Assets/Scenes/X.unity", 3]]);
    expect(
      (readFileSync(join(root, "Assets/Scenes/X.unity"), "utf8").match(/^GameObject:/gm) ?? []).length,
    ).toBe(3);
  });
});
