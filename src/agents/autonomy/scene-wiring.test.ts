/**
 * The check that would have failed the run that reported success.
 *
 * Measured: nine modules, fifty C# files, sixteen test assemblies, all
 * compiling, and no scene, no ScriptableObject asset and no bootstrapper. Every
 * code-shape rule passed. These read the artifacts instead.
 */

import { describe, it, expect } from "vitest";
import { assessSceneWiring, type SceneWiringIo } from "./scene-wiring.js";

/** A project that exists only as a file listing. */
function project(files: Record<string, string>): SceneWiringIo {
  return {
    exists: (p) => p.endsWith("Assets") || p in files,
    listFiles: () => Object.keys(files),
    readFile: (p) => files[p] ?? "",
  };
}

const WIRED_SCENE = `
MonoBehaviour:
  m_Script: {fileID: 11500000, guid: aaaa, type: 3}
  _gameConfig: {fileID: 11400000, guid: bbbb, type: 2}
`;

const UNWIRED_SCENE = `
MonoBehaviour:
  m_Script: {fileID: 11500000, guid: aaaa, type: 3}
  _gameConfig: {fileID: 0}
`;

describe("a delivered game", () => {
  it("passes when a scene wires a bootstrapper to a config that exists", () => {
    const io = project({
      "/p/Assets/Modules/BoardModule/Scripts/BoardModuleConfig.cs": "",
      "/p/Assets/Generated/BoardModuleConfig.asset": "",
      "/p/Assets/Scenes/Main.unity": WIRED_SCENE,
    });

    const report = assessSceneWiring("/p", io);

    expect(report.problems, JSON.stringify(report.problems)).toEqual([]);
    expect(report.wired).toBe(true);
  });

  it("fails a run that produced code and no scene", () => {
    // The measured case, exactly.
    const io = project({
      "/p/Assets/Modules/BoardModule/Scripts/BoardModuleConfig.cs": "",
      "/p/Assets/Modules/BoardModule/BoardModule.asmdef": "",
    });

    const report = assessSceneWiring("/p", io);

    expect(report.wired).toBe(false);
    expect(report.problems.map((p) => p.kind)).toContain("no-scene");
  });

  it("fails a ModuleConfig class with no asset behind it", () => {
    // The bootstrapper holds asset references, not types: a class with no asset
    // is a module nothing can load.
    const io = project({
      "/p/Assets/Modules/BoardModule/Scripts/BoardModuleConfig.cs": "",
      "/p/Assets/Scenes/Main.unity": WIRED_SCENE,
    });

    const report = assessSceneWiring("/p", io);

    expect(report.problems.map((p) => p.kind)).toContain("missing-config-asset");
    expect(report.problems.find((p) => p.kind === "missing-config-asset")?.detail)
      .toContain("BoardModuleConfig");
  });

  it("fails a scene with no bootstrapper in it", () => {
    const io = project({
      "/p/Assets/Scenes/Main.unity": "GameObject:\n  m_Name: Camera\n",
    });

    const report = assessSceneWiring("/p", io);

    expect(report.problems.map((p) => p.kind)).toContain("no-bootstrapper");
  });

  it("fails a bootstrapper assigned to nothing", () => {
    // {fileID: 0} is a null wearing the shape of a link. The field is present,
    // the scene loads, the game boots and does nothing.
    const io = project({
      "/p/Assets/Generated/BoardModuleConfig.asset": "",
      "/p/Assets/Modules/BoardModule/Scripts/BoardModuleConfig.cs": "",
      "/p/Assets/Scenes/Main.unity": UNWIRED_SCENE,
    });

    const report = assessSceneWiring("/p", io);

    expect(report.wired).toBe(false);
    expect(report.problems.map((p) => p.kind)).toContain("unwired-bootstrapper");
    expect(report.problems.find((p) => p.kind === "unwired-bootstrapper")?.detail)
      .toMatch(/fileID: 0/);
  });

  it("does not mistake a present field for an assigned one", () => {
    // The weak check that hid this during development: asserting the field name
    // appears in the file. It appears in both cases.
    const wired = assessSceneWiring("/p", project({
      "/p/Assets/Scenes/A.unity": WIRED_SCENE,
    }));
    const unwired = assessSceneWiring("/p", project({
      "/p/Assets/Scenes/A.unity": UNWIRED_SCENE,
    }));

    expect(wired.problems.some((p) => p.kind === "unwired-bootstrapper")).toBe(false);
    expect(unwired.problems.some((p) => p.kind === "unwired-bootstrapper")).toBe(true);
  });

  it("reports a project with no Assets directory rather than throwing", () => {
    const report = assessSceneWiring("/nowhere", {
      exists: () => false,
      listFiles: () => [],
      readFile: () => "",
    });

    expect(report.wired).toBe(false);
    expect(report.problems).toHaveLength(1);
  });
});

describe("an asset whose file name is not the class name", () => {
  // Measured 2026-08-20 end to end: unity_scene_build assembled a scene from a
  // real GDD run, verified every reference on disk, and its play-mode boot test
  // passed — and this check called the project unassembled, because the tool
  // names its assets UIModule.asset while the class is UIModuleConfig. A
  // correctly built game accused of being a library sends the agent back to
  // rebuild what it had already got right.
  const CONFIG_ASSET = `
MonoBehaviour:
  m_ObjectHideFlags: 0
  m_Script: {fileID: 11500000, guid: c0ffee00c0ffee00c0ffee00c0ffee00, type: 3}
  m_Name: UIModule
`;

  it("recognises the asset by the script it instantiates", () => {
    const io = project({
      "/p/Assets/Modules/UI/UIModuleConfig.cs": "",
      "/p/Assets/Modules/UI/UIModuleConfig.cs.meta": "guid: c0ffee00c0ffee00c0ffee00c0ffee00\n",
      "/p/Assets/Settings/Modules/UIModule.asset": CONFIG_ASSET,
      "/p/Assets/Scenes/Main.unity": WIRED_SCENE,
    });

    const report = assessSceneWiring("/p", io);

    expect(report.problems, JSON.stringify(report.problems)).toEqual([]);
    expect(report.wired).toBe(true);
  });

  it("still accuses when no asset instantiates the class", () => {
    const io = project({
      "/p/Assets/Modules/UI/UIModuleConfig.cs": "",
      "/p/Assets/Modules/UI/UIModuleConfig.cs.meta": "guid: c0ffee00c0ffee00c0ffee00c0ffee00\n",
      // An asset, but of some other script.
      "/p/Assets/Settings/Other.asset": CONFIG_ASSET.replace("c0ffee00c0ffee00c0ffee00c0ffee00", "dddddddddddddddddddddddddddddddd"),
      "/p/Assets/Scenes/Main.unity": WIRED_SCENE,
    });

    const report = assessSceneWiring("/p", io);

    expect(report.problems.map((p) => p.kind)).toContain("missing-config-asset");
  });

  it("falls back to the name when the project has no .meta files", () => {
    const io = project({
      "/p/Assets/Modules/Board/BoardModuleConfig.cs": "",
      "/p/Assets/Generated/BoardModuleConfig.asset": "",
      "/p/Assets/Scenes/Main.unity": WIRED_SCENE,
    });

    expect(assessSceneWiring("/p", io).wired).toBe(true);
  });
});

describe("a prefab whose scripts do not exist", () => {
  // Measured 2026-08-20: rather than calling unity_scene_build, an agent
  // hand-wrote twenty-five .prefab files. The YAML parsed, the structure was
  // right, the .meta files were there — and every m_Script guid in them was
  // invented. Six references, six resolving to nothing. Unity loads that as
  // "Missing (Mono Script)", and every check that reads shape rather than
  // identity says the project is fine.
  const REAL_GUID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const INVENTED = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  function prefabCiting(guid: string): string {
    return `GameObject:\nMonoBehaviour:\n  m_Script: {fileID: 11500000, guid: ${guid}, type: 3}\n`;
  }

  it("names a prefab that cites a guid no script has", () => {
    const io = project({
      "/p/Assets/Modules/Board/BoardModuleConfig.cs": "",
      "/p/Assets/Modules/Board/BoardModuleConfig.cs.meta": `guid: ${REAL_GUID}\n`,
      "/p/Assets/Settings/BoardModuleConfig.asset": "",
      "/p/Assets/Prefabs/Pig_Blue.prefab": prefabCiting(INVENTED),
      "/p/Assets/Scenes/Main.unity": WIRED_SCENE,
    });

    const report = assessSceneWiring("/p", io);

    const problem = report.problems.find((p) => p.kind === "dangling-script-reference");
    expect(problem, JSON.stringify(report.problems)).toBeDefined();
    expect(problem!.detail).toContain("Pig_Blue.prefab");
    expect(report.wired).toBe(false);
  });

  it("stays quiet when the guid belongs to a script that exists", () => {
    const io = project({
      "/p/Assets/Modules/Board/BoardModuleConfig.cs": "",
      "/p/Assets/Modules/Board/BoardModuleConfig.cs.meta": `guid: ${REAL_GUID}\n`,
      "/p/Assets/Settings/BoardModuleConfig.asset": "",
      "/p/Assets/Prefabs/Pig_Blue.prefab": prefabCiting(REAL_GUID),
      "/p/Assets/Scenes/Main.unity": WIRED_SCENE,
    });

    expect(assessSceneWiring("/p", io).problems.filter((p) => p.kind === "dangling-script-reference")).toEqual([]);
  });

  it("accuses nothing when the project keeps no .meta files to check against", () => {
    // Absence of evidence: without any .cs.meta to read, every guid looks
    // invented and the rule would condemn a perfectly ordinary project.
    const io = project({
      "/p/Assets/Modules/Board/BoardModuleConfig.cs": "",
      "/p/Assets/Settings/BoardModuleConfig.asset": "",
      "/p/Assets/Prefabs/Pig_Blue.prefab": prefabCiting(INVENTED),
      "/p/Assets/Scenes/Main.unity": WIRED_SCENE,
    });

    expect(assessSceneWiring("/p", io).problems.filter((p) => p.kind === "dangling-script-reference")).toEqual([]);
  });
});
