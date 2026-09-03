import { describe, expect, it } from "vitest";
import { assessSceneHygiene } from "./scene-hygiene.js";

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

  it("never promotes a scaffolding-named scene while a real one exists", () => {
    const report = assessSceneHygiene("/p", io({
      "ProjectSettings/EditorBuildSettings.asset": settings([
        "Assets/Scenes/UfoShowcase.unity",
        "Assets/Scenes/ProductionMain.unity",
      ]),
      // The scaffolding scene is RICHER, so a count-only rule would pick it.
      "Assets/Scenes/UfoShowcase.unity": Array.from({ length: 9 }, () => "GameObject:").join("\n"),
      "Assets/Scenes/ProductionMain.unity": Array.from({ length: 4 }, () => "GameObject:").join("\n"),
    }) as never);

    expect(report.entry?.path).toBe("Assets/Scenes/ProductionMain.unity");
  });
});
