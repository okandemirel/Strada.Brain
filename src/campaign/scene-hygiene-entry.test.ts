import { describe, expect, it } from "vitest";
import { assessSceneHygiene, renderSceneHygiene } from "./scene-hygiene.js";

/**
 * Two holes the merge exposed (audited 2026-09-03):
 *  - a scene composed of PREFAB INSTANCES held no literal GameObject blocks,
 *    was read as empty, and the entry-scene refusal fired on a good build;
 *  - the entry scene was chosen purely by object count, so a scaffolding-NAMED
 *    scene could be promoted to "open this and press Play".
 */
function io(files: Record<string, string>) {
  return {
    exists: (p: string) => Object.keys(files).some((k) => p.endsWith(k)),
    readFile: (p: string) => {
      const hit = Object.keys(files).find((k) => p.endsWith(k));
      if (!hit) throw new Error("missing");
      return files[hit]!;
    },
  };
}

const settings = (paths: string[]): string =>
  ["EditorBuildSettings:", "  m_Scenes:", ...paths.flatMap((p) => ["  - enabled: 1", `    path: ${p}`])].join("\n");

describe("scene hygiene entry selection", () => {
  it("counts a prefab-composed scene as content, not as empty", () => {
    const report = assessSceneHygiene("/p", io({
      "ProjectSettings/EditorBuildSettings.asset": settings(["Assets/Scenes/Game.unity"]),
      "Assets/Scenes/Game.unity": "PrefabInstance:\n  x: 1\nPrefabInstance:\n  x: 2\nPrefabInstance:\n  x: 3",
    }) as never);

    expect(report.refusal).toBeUndefined();
    expect(report.entry?.path).toBe("Assets/Scenes/Game.unity");
    expect(report.entry?.objects).toBe(3);
  });

  it("an unreadable or empty first scene does not let a later scene claim index 0, and does not erase the rest (Codex 2026-09-11 D#19, D#20)", () => {
    // Empty first scene: the recommendation moves on, but what the build
    // opens is named.
    const empty = assessSceneHygiene("/p", io({
      "ProjectSettings/EditorBuildSettings.asset": settings(["Assets/Scenes/Boot.unity", "Assets/Scenes/Game.unity"]),
      "Assets/Scenes/Boot.unity": "",
      "Assets/Scenes/Game.unity": Array.from({ length: 20 }, () => "GameObject:").join("\n"),
    }) as never);
    expect(empty.refusal).toBeUndefined();
    expect(empty.entry?.path).toBe("Assets/Scenes/Game.unity");
    expect(empty.buildOpensInstead?.path).toBe("Assets/Scenes/Boot.unity");
    expect(renderSceneHygiene(empty)).toContain("opens `Boot.unity` FIRST");

    // Every readable scene empty: that IS the refusal.
    const allEmpty = assessSceneHygiene("/p", io({
      "ProjectSettings/EditorBuildSettings.asset": settings(["Assets/Scenes/A.unity", "Assets/Scenes/B.unity"]),
      "Assets/Scenes/A.unity": "",
      "Assets/Scenes/B.unity": "",
    }) as never);
    expect(allEmpty.refusal?.kind).toBe("entry-unidentifiable");
  });

  it("names the scene the BUILD opens, and the richer one beside it (Codex 2026-09-11 C#26)", () => {
    const report = assessSceneHygiene("/p", io({
      "ProjectSettings/EditorBuildSettings.asset": settings([
        "Assets/Scenes/UfoShowcase.unity",
        "Assets/Scenes/ProductionMain.unity",
      ]),
      // The scaffolding scene is RICHER, so a count-only rule would pick it.
      "Assets/Scenes/UfoShowcase.unity": Array.from({ length: 9 }, () => "GameObject:").join("\n"),
      "Assets/Scenes/ProductionMain.unity": Array.from({ length: 4 }, () => "GameObject:").join("\n"),
    }) as never);

    // Unity loads build index 0, so that is the scene a person gets — saying
    // "open ProductionMain" described a game nobody would see. The richer
    // scene is named beside it with what to do about it.
    expect(report.entry?.path).toBe("Assets/Scenes/UfoShowcase.unity");
    expect(report.richest?.path).toBe("Assets/Scenes/ProductionMain.unity");
    expect(renderSceneHygiene(report)).toContain("NOT what the build opens");
  });
});
