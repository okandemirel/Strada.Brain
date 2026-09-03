import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import {
  assessBuiltAsSpecified,
  isScaffoldingScene,
  readEnabledBuildScenes,
} from "./built-as-specified.js";

/**
 * The delivered game measured, not the delivery report re-read.
 *
 * Audited 2026-09-03: PixelFlow shipped as "game build complete" with an entry
 * scene holding zero MeshFilter/MeshRenderer, five runtime scripts calling
 * GameObject.CreatePrimitive, and 100 prefabs / 198 pngs / 62 models nothing
 * bound. Every fixture below is a file shape Unity itself would read.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(os.tmpdir(), "built-as-specified-"));
  roots.push(root);
  mkdirSync(join(root, "Assets"), { recursive: true });
  return root;
}

/** Writes a file plus, for assets, the .meta sidecar carrying its guid. */
function put(root: string, rel: string, body: string, guid?: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  if (guid) writeFileSync(`${abs}.meta`, `fileFormatVersion: 2\nguid: ${guid}\n`);
}

function buildSettings(root: string, scenes: Array<{ path: string; enabled?: boolean }>): void {
  const body = scenes
    .map(
      (s, i) =>
        `  - enabled: ${s.enabled === false ? 0 : 1}\n    path: ${s.path}\n    guid: ${String(i).padStart(32, "a")}\n`,
    )
    .join("");
  put(root, "ProjectSettings/EditorBuildSettings.asset", `EditorBuildSettings:\n  m_Scenes:\n${body}`);
}

const CAMERA = (orthographic: 0 | 1): string =>
  `--- !u!20 &900\nCamera:\n  m_Enabled: 1\n  orthographic: ${orthographic}\n  orthographic size: 5\n`;

const HEADER = "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n";

const prefabInstance = (guid: string, id = 1001): string =>
  `--- !u!1001 &${id}\nPrefabInstance:\n  m_ObjectHideFlags: 0\n  m_Modification:\n    m_Modifications: []\n  m_SourcePrefab: {fileID: 100100000, guid: ${guid}, type: 3}\n`;

/** A prefab whose SpriteRenderer binds a real project sprite. */
const artPrefab = (spriteGuid: string): string =>
  `${HEADER}--- !u!1 &7\nGameObject:\n  m_Name: Pig\n` +
  `--- !u!212 &8\nSpriteRenderer:\n  m_Enabled: 1\n  m_Materials:\n  - {fileID: 2100000, guid: aaaabbbbccccddddeeeeffff00001111, type: 2}\n` +
  `  m_Sprite: {fileID: 21300000, guid: ${spriteGuid}, type: 3}\n`;

/** A prefab whose renderers are Unity built-ins only (Cube + Default-Material). */
const primitivePrefab = (): string =>
  `${HEADER}--- !u!1 &7\nGameObject:\n  m_Name: Block\n` +
  `--- !u!33 &9\nMeshFilter:\n  m_Mesh: {fileID: 10202, guid: 0000000000000000e000000000000000, type: 0}\n` +
  `--- !u!23 &8\nMeshRenderer:\n  m_Enabled: 1\n  m_Materials:\n  - {fileID: 10303, guid: 0000000000000000f000000000000000, type: 0}\n`;

describe("readEnabledBuildScenes", () => {
  it("returns enabled scenes in build order and drops disabled ones", () => {
    const root = project();
    buildSettings(root, [
      { path: "Assets/Scenes/Main.unity" },
      { path: "Assets/Scenes/Old.unity", enabled: false },
      { path: "Assets/Scenes/Extra.unity" },
    ]);
    const io = {
      listFiles: (): string[] => [],
      readFile: (p: string): string => readFileSync(p, "utf-8"),
      exists: (p: string): boolean => existsSync(p),
    };
    expect(readEnabledBuildScenes(root, io)).toEqual([
      "Assets/Scenes/Main.unity",
      "Assets/Scenes/Extra.unity",
    ]);
  });
});

describe("isScaffoldingScene", () => {
  it("recognises Unity's generated test scene and Tests/Editor folders only", () => {
    expect(isScaffoldingScene("Assets/InitTestScene4abd18f9-8be4.unity")).toBe(true);
    expect(isScaffoldingScene("Assets/Tests/Runtime/Boot.unity")).toBe(true);
    expect(isScaffoldingScene("Assets/Editor/Bake.unity")).toBe(true);
    // Never a name list: renaming an empty scene must not excuse it.
    expect(isScaffoldingScene("Assets/Scenes/AssembledGame.unity")).toBe(false);
    expect(isScaffoldingScene("Assets/Scenes/TargetedLevel151Verification.unity")).toBe(false);
  });
});

describe("assessBuiltAsSpecified — refusal", () => {
  it("refuses the real delivery shape: nothing placed, primitives in code, art unbound", () => {
    const root = project();
    buildSettings(root, [
      { path: "Assets/Scenes/ProductionMain.unity" },
      { path: "Assets/InitTestScene4abd18f9.unity" },
    ]);
    // The entry scene: a camera, a bootstrapper pointing at a config asset,
    // and not one renderer — exactly ProductionMain.unity.
    put(
      root,
      "Assets/Scenes/ProductionMain.unity",
      `${HEADER}${CAMERA(0)}--- !u!114 &500\nMonoBehaviour:\n  _config: {fileID: 11400000, guid: c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0, type: 2}\n`,
      "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
    );
    put(root, "Assets/InitTestScene4abd18f9.unity", `${HEADER}${CAMERA(0)}`, "5cf5f5f5f5f5f5f5f5f5f5f5f5f5f5f5");
    // A config the scene references, pointing at a prefab that IS art — but
    // the scene never places it.
    put(
      root,
      "Assets/Settings/PresentationPrefabConfig.asset",
      `${HEADER}--- !u!114 &11400000\nMonoBehaviour:\n  _pigPrefab: {fileID: 7, guid: 11111111111111111111111111111111, type: 3}\n`,
      "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0",
    );
    put(root, "Assets/Prefabs/Pig.prefab", artPrefab("22222222222222222222222222222222"), "11111111111111111111111111111111");
    put(root, "Assets/Art/pig.png", "pixels", "22222222222222222222222222222222");
    // Unbound art: a prefab and a model nothing reaches.
    put(root, "Assets/Prefabs/Ball.prefab", artPrefab("44444444444444444444444444444444"), "33333333333333333333333333333333");
    put(root, "Assets/Art/Models/Pig.fbx", "binary", "55555555555555555555555555555555");
    put(root, "Assets/Art/ball.png", "pixels", "44444444444444444444444444444444");
    // The geometry the player actually sees.
    put(
      root,
      "Assets/Scripts/PlayfieldBuilder.cs",
      "public class PlayfieldBuilder { void Build() { GameObject.CreatePrimitive(PrimitiveType.Cube); } }",
      "66666666666666666666666666666666",
    );

    const report = assessBuiltAsSpecified(root);

    expect(report.refusal).toBeDefined();
    expect(report.refusal).toContain("render NOTHING");
    // Names the scene…
    expect(report.refusal).toContain("Assets/Scenes/ProductionMain.unity");
    // …the counts…
    expect(report.refusal).toContain("0 renderer components");
    // …and the unbound assets it found.
    expect(report.refusal).toContain("Assets/Prefabs/Ball.prefab");
    expect(report.refusal).toContain("Assets/Art/Models/Pig.fbx");
    expect(report.refusal).toContain("GameObject.CreatePrimitive");
    expect(report.shippedRenderers).toBe(0);
    // The scaffolding scene is measured but not judged as shipped work.
    expect(report.shippedScenes.map((s) => s.scene)).toEqual(["Assets/Scenes/ProductionMain.unity"]);
    // The prefab the config points at is NOT called unbound…
    expect(report.unboundPrefabs).not.toContain("Assets/Prefabs/Pig.prefab");
    // …but its 1 renderer is reported as referenced-only, never as shipped.
    expect(report.referencedOnlyRenderers).toBe(1);
    expect(report.unboundPrefabs).toContain("Assets/Prefabs/Ball.prefab");
    expect(report.primitiveScripts).toEqual(["Assets/Scripts/PlayfieldBuilder.cs"]);
  });

  it("refuses when every placed renderer is a Unity built-in and art sits unbound", () => {
    const root = project();
    buildSettings(root, [{ path: "Assets/Scenes/Main.unity" }]);
    put(
      root,
      "Assets/Scenes/Main.unity",
      `${HEADER}${CAMERA(0)}${prefabInstance("11111111111111111111111111111111")}`,
      "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
    );
    put(root, "Assets/Prefabs/Block.prefab", primitivePrefab(), "11111111111111111111111111111111");
    put(root, "Assets/Prefabs/Pig.prefab", artPrefab("22222222222222222222222222222222"), "33333333333333333333333333333333");
    put(root, "Assets/Art/pig.png", "pixels", "22222222222222222222222222222222");

    const report = assessBuiltAsSpecified(root);

    expect(report.shippedRenderers).toBe(1);
    expect(report.shippedProjectRefs).toBe(0);
    expect(report.shippedBuiltInRefs).toBe(2);
    expect(report.refusal).toContain("Every renderer the shipped scenes have is a Unity built-in");
    expect(report.refusal).toContain("Default-Material");
    expect(report.refusal).toContain("built-in Cube mesh");
    expect(report.refusal).toContain("Assets/Prefabs/Pig.prefab");
  });
});

describe("assessBuiltAsSpecified — passes", () => {
  it("passes a scene that places prefabs binding real project art", () => {
    const root = project();
    buildSettings(root, [{ path: "Assets/Scenes/Main.unity" }]);
    put(
      root,
      "Assets/Scenes/Main.unity",
      `${HEADER}${CAMERA(1)}${prefabInstance("11111111111111111111111111111111")}`,
      "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
    );
    put(root, "Assets/Prefabs/Pig.prefab", artPrefab("22222222222222222222222222222222"), "11111111111111111111111111111111");
    put(root, "Assets/Art/pig.png", "pixels", "22222222222222222222222222222222");

    const report = assessBuiltAsSpecified(root);

    expect(report.refusal).toBeUndefined();
    expect(report.shippedRenderers).toBe(1);
    expect(report.shippedSpriteRenderers).toBe(1);
    expect(report.shippedProjectRefs).toBe(2); // the sprite and its material
    expect(report.unboundPrefabs).toEqual([]);
    expect(report.disclosures.join("\n")).toContain("Shipped scenes PLACE 1 renderer component");
  });

  it("passes a project with no art at all, and records why no claim is possible", () => {
    const root = project();
    buildSettings(root, [{ path: "Assets/Scenes/Main.unity" }]);
    put(root, "Assets/Scenes/Main.unity", `${HEADER}${CAMERA(0)}`, "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5");

    const report = assessBuiltAsSpecified(root);

    expect(report.refusal).toBeUndefined();
    expect(report.artInventory).toEqual({ prefabs: 0, models: 0, sprites: 0 });
    expect(report.disclosures.join("\n")).toContain("no prefabs, imported models or sprite textures at all");
    // A skipped claim must not read like a passed one.
    expect(report.disclosures.join("\n")).toContain("Shipped scenes PLACE 0 renderer components");
  });

  it("never triggers on test scaffolding: empty InitTestScene, Tests/ fixtures, Editor code", () => {
    const root = project();
    buildSettings(root, [
      { path: "Assets/Scenes/Main.unity" },
      { path: "Assets/InitTestScene4abd18f9-8be4-4a53.unity" },
      { path: "Assets/Tests/Runtime/BootFixture.unity" },
    ]);
    put(
      root,
      "Assets/Scenes/Main.unity",
      `${HEADER}${CAMERA(0)}${prefabInstance("11111111111111111111111111111111")}`,
      "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
    );
    put(root, "Assets/InitTestScene4abd18f9-8be4-4a53.unity", `${HEADER}${CAMERA(0)}`, "5cf5f5f5f5f5f5f5f5f5f5f5f5f5f5f5");
    put(root, "Assets/Tests/Runtime/BootFixture.unity", `${HEADER}${CAMERA(0)}`, "5cd5d5d5d5d5d5d5d5d5d5d5d5d5d5d5");
    put(root, "Assets/Prefabs/Pig.prefab", artPrefab("22222222222222222222222222222222"), "11111111111111111111111111111111");
    put(root, "Assets/Art/pig.png", "pixels", "22222222222222222222222222222222");
    // A fixture prefab and an editor-only tool: neither is the game's art or
    // the game's geometry.
    put(root, "Assets/Tests/Runtime/Fixture.prefab", artPrefab("44444444444444444444444444444444"), "77777777777777777777777777777777");
    put(
      root,
      "Assets/Editor/SceneBaker.cs",
      "class SceneBaker { void Bake() { GameObject.CreatePrimitive(PrimitiveType.Cube); } }",
      "88888888888888888888888888888888",
    );
    put(
      root,
      "Assets/Tests/Runtime/PlayTest.cs",
      "class PlayTest { void T() { GameObject.CreatePrimitive(PrimitiveType.Sphere); } }",
      "99999999999999999999999999999999",
    );

    const report = assessBuiltAsSpecified(root);

    expect(report.refusal).toBeUndefined();
    expect(report.scenes.filter((s) => s.scaffolding).map((s) => s.scene)).toEqual([
      "Assets/InitTestScene4abd18f9-8be4-4a53.unity",
      "Assets/Tests/Runtime/BootFixture.unity",
    ]);
    expect(report.shippedScenes.map((s) => s.scene)).toEqual(["Assets/Scenes/Main.unity"]);
    // A Tests/ fixture prefab is not the game's unshipped art.
    expect(report.unboundPrefabs).toEqual([]);
    // Editor and Tests geometry is not the game building primitives.
    expect(report.primitiveScripts).toEqual([]);
  });

  it("does not count a commented-out CreatePrimitive as geometry built in code", () => {
    const root = project();
    buildSettings(root, [{ path: "Assets/Scenes/Main.unity" }]);
    put(
      root,
      "Assets/Scenes/Main.unity",
      `${HEADER}${CAMERA(0)}${prefabInstance("11111111111111111111111111111111")}`,
      "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
    );
    put(root, "Assets/Prefabs/Pig.prefab", artPrefab("22222222222222222222222222222222"), "11111111111111111111111111111111");
    put(root, "Assets/Art/pig.png", "pixels", "22222222222222222222222222222222");
    put(
      root,
      "Assets/Scripts/Dead.cs",
      "class Dead {\n  // GameObject.CreatePrimitive(PrimitiveType.Cube);\n  /* PrimitiveType.Sphere */\n}",
      "66666666666666666666666666666666",
    );

    expect(assessBuiltAsSpecified(root).primitiveScripts).toEqual([]);
  });
});

describe("assessBuiltAsSpecified — what it could not measure", () => {
  it("records a missing Assets directory instead of reporting a clean project", () => {
    const root = mkdtempSync(join(os.tmpdir(), "built-as-specified-"));
    roots.push(root);
    const report = assessBuiltAsSpecified(root);
    expect(report.measured).toBe(false);
    expect(report.refusal).toBeUndefined();
    expect(report.incomplete.join("\n")).toContain("no Assets/ directory");
  });

  it("records a scene that is in the build list but not on disk", () => {
    const root = project();
    buildSettings(root, [{ path: "Assets/Scenes/Gone.unity" }]);
    const report = assessBuiltAsSpecified(root);
    expect(report.incomplete.join("\n")).toContain("Assets/Scenes/Gone.unity is enabled in Build Settings");
    // Nothing was measured, so nothing is refused.
    expect(report.refusal).toBeUndefined();
  });

  it("records that no scene is enabled rather than passing silently", () => {
    const root = project();
    buildSettings(root, [{ path: "Assets/Scenes/Main.unity", enabled: false }]);
    const report = assessBuiltAsSpecified(root);
    expect(report.incomplete.join("\n")).toContain("lists no ENABLED scene");
    expect(report.refusal).toBeUndefined();
  });
});
