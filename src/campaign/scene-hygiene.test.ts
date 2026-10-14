import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { assessSceneHygiene, renderSceneHygiene } from "./scene-hygiene.js";

/**
 * Measured on the delivered test-game tree 2026-09-03: a long list of scenes
 * enabled in Build Settings, and the person who opened it could not tell which
 * one is the game. The fixture below is an invented tree of that kind: the
 * scene the build opens first, a richer one later, scaffolding by name and by
 * size, and scenes that match neither rule.
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

/** A cluttered delivered build (path, GameObject count), in build order. */
const CLUTTERED_DELIVERY: ReadonlyArray<[string, number]> = [
  ["Assets/Scenes/Atrium.unity", 4],
  ["Assets/Scenes/Observatory.unity", 7],
  ["Assets/Scenes/KelpSandbox.unity", 6],
  ["Assets/InitTestScene7c1e3a90-52d4-4f0b-9e6a-b83d1c05f2a7.unity", 5],
  ["Assets/Scenes/Ballroom.unity", 2],
  ["Assets/Scenes/DockSmokeTest.unity", 5],
  ["Assets/Modules/AtlasModule/Scenes/AtlasPreview.unity", 1],
  ["Assets/Scenes/Greenhouse.unity", 5],
  ["Assets/Scenes/ReefTestScene.unity", 3],
  ["Assets/Scenes/Planetarium.unity", 21],
];

describe("scene hygiene — a cluttered delivered build", () => {
  it("names the entry scene and discloses every other enabled scene", () => {
    const report = assessSceneHygiene(project(CLUTTERED_DELIVERY));

    expect(report.refusal).toBeUndefined();
    expect(report.enabled).toHaveLength(10);
    // The build opens its FIRST enabled scene; the richest one is named
    // beside it (Codex 2026-09-11 C#26).
    expect(report.entry?.path).toBe("Assets/Scenes/Atrium.unity");
    expect(report.entry?.objects).toBe(4);
    expect(report.richest?.path).toBe("Assets/Scenes/Planetarium.unity");
    // 9 enabled scenes are NOT the entry point — the whole of the user's
    // "which one is the game?".
    expect(report.otherEnabled).toBe(9);
    // Of those 9, these match scaffolding shape (name, or fewer than 3
    // GameObjects). Observatory(7), Greenhouse(5) and Planetarium(21) match
    // neither rule and are disclosed as unclassified, never as scaffolding.
    expect(report.scaffolding.map((s) => s.path).sort()).toEqual(
      [
        "Assets/InitTestScene7c1e3a90-52d4-4f0b-9e6a-b83d1c05f2a7.unity",
        "Assets/Modules/AtlasModule/Scenes/AtlasPreview.unity",
        "Assets/Scenes/Ballroom.unity",
        "Assets/Scenes/DockSmokeTest.unity",
        "Assets/Scenes/KelpSandbox.unity",
        "Assets/Scenes/ReefTestScene.unity",
      ].sort(),
    );
    // Atrium is the entry (build index 0), so the non-entry unclassified
    // list carries Planetarium, the richest scene (Codex 2026-09-11 C#26).
    expect(report.unclassified.map((s) => s.path).sort()).toEqual([
      "Assets/Scenes/Greenhouse.unity",
      "Assets/Scenes/Observatory.unity",
      "Assets/Scenes/Planetarium.unity",
    ]);

    const text = renderSceneHygiene(report);
    expect(text).toContain("Assets/Scenes/Atrium.unity");
    expect(text).toContain("Planetarium.unity");
    expect(text).toContain("21 objects");
    expect(text).toContain("9 other scenes are enabled");
    expect(text).toContain("6 of them");
    expect(text).toContain("verification scaffolding");
    // A count with no names is not a disclosure a person can act on.
    expect(text).toContain("ReefTestScene.unity");
    // The three that match neither rule are named too — silence about them
    // would read as "the other 9 are all disposable".
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
    // Unity opens the FIRST enabled scene, so a tie is broken by build order,
    // not by path (Codex 2026-09-11 B#15).
    expect(report.entry?.path).toBe("Assets/Scenes/B.unity");
    expect(report.entryTied).toEqual(["Assets/Scenes/A.unity"]);
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
