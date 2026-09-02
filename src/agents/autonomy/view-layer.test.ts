import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import { assessFrameworkBypass, assessViewLayer } from "./scene-wiring.js";

/**
 * Audited 2026-09-02: the default walk listed ALL of Assets/ unbounded, then
 * assessViewLayer/assessFrameworkBypass kept the first 4000 entries — in LIFO
 * order, so an imported pack that sorts last was walked first and filled the
 * slice with textures. No .prefab in the slice meant `null`, and the NO CAMERA
 * and NOTHING RENDERS gates were skipped without anything recording that they
 * were skipped rather than satisfied; the bypass rule likewise read "no
 * reimplementation".
 */
describe("an imported pack larger than the file budget", () => {
  it("does not hide the scene's missing camera or the project's reimplementation", () => {
    const root = mkdtempSync(join(os.tmpdir(), "view-layer-pack-"));
    const mod = join(root, "Assets", "Modules", "Board");
    mkdirSync(join(mod, "Prefabs"), { recursive: true });
    writeFileSync(
      join(mod, "BoardService.cs"),
      "public class BoardService { " + "public event System.Action Changed; ".repeat(6) + "}",
    );
    writeFileSync(join(mod, "Prefabs", "Cube.prefab"), "SpriteRenderer:");
    mkdirSync(join(root, "Assets", "Scenes"), { recursive: true });
    writeFileSync(join(root, "Assets", "Scenes", "Gameplay.unity"), "GameObject:\nTransform:");
    const textures = join(root, "Assets", "ZZThirdParty", "BigPack", "Textures");
    mkdirSync(textures, { recursive: true });
    for (let i = 0; i < 2500; i++) {
      writeFileSync(join(textures, `t${i}.png`), "p");
      writeFileSync(join(textures, `t${i}.png.meta`), "guid: 0");
    }

    const views = assessViewLayer(root);
    expect(views?.camerslessScenes).toEqual(["Gameplay.unity"]);
    expect(views?.hasViews).toBe(false);
    expect(assessFrameworkBypass(root).map((b) => b.what)).toContain("hand-rolled C# events");
  });
});

function io(files: Record<string, string>) {
  return {
    listFiles: () => Object.keys(files),
    readFile: (p: string) => files[p] ?? "",
    exists: () => true,
  };
}

const SERVICE = "namespace Game { public class BoardService : IBoardService { } }";

describe("whether a project can render anything", () => {
  it("reports no views when prefabs exist and nothing drives them", () => {
    // The measured shape: services and systems, prefabs, and no MonoBehaviour.
    const result = assessViewLayer("/p", io({
      "/p/Assets/Modules/Board/BoardService.cs": SERVICE,
      "/p/Assets/Modules/Board/BoardSystem.cs": "public class BoardSystem : SystemBase { }",
      "/p/Assets/Modules/Board/Prefabs/Cube.prefab": "",
    }));

    expect(result?.hasViews).toBe(false);
    expect(result?.prefabCount).toBe(1);
    expect(result?.scriptCount).toBe(2);
  });

  it("counts a MonoBehaviour as a view", () => {
    const result = assessViewLayer("/p", io({
      "/p/Assets/Modules/Board/CubeView.cs": "public class CubeView : MonoBehaviour { }",
      "/p/Assets/Modules/Board/Prefabs/Cube.prefab": "",
    }));

    expect(result?.hasViews).toBe(true);
  });

  it("counts Strada.Core's own bridge as a view", () => {
    const result = assessViewLayer("/p", io({
      "/p/Assets/Modules/Board/CubeBinding.cs": "public class CubeBinding : EntityMediator { }",
      "/p/Assets/Modules/Board/Prefabs/Cube.prefab": "",
    }));

    expect(result?.hasViews).toBe(true);
  });

  it("says nothing about a project with no prefabs to render", () => {
    // A simulation or a library owes nobody a view.
    expect(assessViewLayer("/p", io({ "/p/Assets/Lib/Thing.cs": SERVICE }))).toBeNull();
  });

  it("does not count a test as the project's view layer", () => {
    const result = assessViewLayer("/p", io({
      "/p/Assets/Tests/PlayMode/BootTest.cs": "public class BootTest : MonoBehaviour { }",
      "/p/Assets/Modules/Board/BoardService.cs": SERVICE,
      "/p/Assets/Modules/Board/Prefabs/Cube.prefab": "",
    }));

    expect(result?.hasViews).toBe(false);
    expect(result?.scriptCount).toBe(1);
  });

  it("reports a scene with no camera", () => {
    // Measured 2026-08-21: every prefab carried a SpriteRenderer and the only
    // scene held one GameObject and no Camera. Views would not have helped.
    const result = assessViewLayer("/p", io({
      "/p/Assets/Modules/Board/CubeView.cs": "public class CubeView : MonoBehaviour { }",
      "/p/Assets/Modules/Board/Prefabs/Cube.prefab": "SpriteRenderer:",
      "/p/Assets/Scenes/Gameplay.unity": "GameObject:\nTransform:",
    }));

    expect(result?.camerslessScenes).toEqual(["Gameplay.unity"]);
  });

  it("says nothing about a scene that has one", () => {
    const result = assessViewLayer("/p", io({
      "/p/Assets/Modules/Board/CubeView.cs": "public class CubeView : MonoBehaviour { }",
      "/p/Assets/Modules/Board/Prefabs/Cube.prefab": "SpriteRenderer:",
      "/p/Assets/Scenes/Gameplay.unity": "GameObject:\nCamera:\n  m_Enabled: 1",
    }));

    expect(result?.camerslessScenes).toEqual([]);
  });
});
