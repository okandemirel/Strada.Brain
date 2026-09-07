/**
 * Measured 2026-09-07: eight remediation attempts on "the shipped scenes
 * render NOTHING", with real sprites and real prefabs on disk and no tool to
 * connect them. These two operations are the missing last mile.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BindSpriteTool, PlacePrefabTool, splitUnityDocs, prefabRoot } from "./scene-binding.js";
import { assessBuiltAsSpecified } from "../../autonomy/built-as-specified.js";
import type { ToolContext } from "../tool.interface.js";

const PREFAB_GUID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SPRITE_GUID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OLD_SPRITE = "cccccccccccccccccccccccccccccccc";

const PREFAB_NO_RENDERER = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100
GameObject:
  m_ObjectHideFlags: 0
  serializedVersion: 6
  m_Component:
  - component: {fileID: 400}
  m_Layer: 0
  m_Name: Pig
  m_IsActive: 1
--- !u!4 &400
Transform:
  m_GameObject: {fileID: 100}
  m_LocalPosition: {x: 0, y: 0, z: 0}
  m_Children: []
  m_Father: {fileID: 0}
`;
const PREFAB_WITH_RENDERER = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100
GameObject:
  m_Component:
  - component: {fileID: 400}
  - component: {fileID: 212000}
  m_Name: Cube
--- !u!4 &400
Transform:
  m_GameObject: {fileID: 100}
  m_Father: {fileID: 0}
--- !u!212 &212000
SpriteRenderer:
  m_GameObject: {fileID: 100}
  m_Sprite: {fileID: 21300000, guid: ${OLD_SPRITE}, type: 3}
  m_WasSpriteAssigned: 0
`;
const SCENE = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!29 &1
OcclusionCullingSettings:
  m_ObjectHideFlags: 0
--- !u!1 &500
GameObject:
  m_Component:
  - component: {fileID: 501}
  m_Name: Main Camera
--- !u!4 &501
Transform:
  m_GameObject: {fileID: 500}
  m_Father: {fileID: 0}
--- !u!1660057539 &9223372036854775807
SceneRoots:
  m_ObjectHideFlags: 0
  m_Roots:
  - {fileID: 501}
`;

let root: string;
let ctx: ToolContext;
function put(rel: string, body: string, guid?: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
  if (guid) writeFileSync(`${abs}.meta`, `fileFormatVersion: 2\nguid: ${guid}\n`);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scene-binding-"));
  ctx = { projectPath: root, workingDirectory: root, readOnly: false } as ToolContext;
  put("Assets/Art/pig.png", "png-bytes");
  writeFileSync(join(root, "Assets/Art/pig.png.meta"), `fileFormatVersion: 2\nguid: ${SPRITE_GUID}\nTextureImporter:\n  textureType: 0\n  spriteMode: 0\n`);
  put("ProjectSettings/EditorBuildSettings.asset", "EditorBuildSettings:\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Main.unity\n    guid: 00000000000000000000000000000001\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("unity_bind_sprite", () => {
  it("adds a SpriteRenderer to an object that has none, registers it, and fixes the importer", async () => {
    put("Assets/Prefabs/Pig.prefab", PREFAB_NO_RENDERER, PREFAB_GUID);
    const r = await new BindSpriteTool().execute({ target: "Assets/Prefabs/Pig.prefab", sprite: "Assets/Art/pig.png" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("ADDED");
    expect(r.content).toContain("importer was switched to Sprite");
    const text = readFileSync(join(root, "Assets/Prefabs/Pig.prefab"), "utf8");
    const { docs } = splitUnityDocs(text);
    const sr = docs.find((d) => d.classId === 212)!;
    expect(sr.text).toContain(`m_Sprite: {fileID: 21300000, guid: ${SPRITE_GUID}, type: 3}`);
    expect(sr.text).toContain("m_GameObject: {fileID: 100}");
    expect(docs.find((d) => d.classId === 1)!.text).toContain(`- component: {fileID: ${sr.fileId}}`);
    expect(readFileSync(join(root, "Assets/Art/pig.png.meta"), "utf8")).toMatch(/textureType: 8/);
  });

  it("replaces the sprite of an existing renderer", async () => {
    put("Assets/Prefabs/Cube.prefab", PREFAB_WITH_RENDERER, PREFAB_GUID);
    const r = await new BindSpriteTool().execute({ target: "Assets/Prefabs/Cube.prefab", sprite: "Assets/Art/pig.png", objectName: "Cube" }, ctx);
    expect(r.isError).toBeFalsy();
    const text = readFileSync(join(root, "Assets/Prefabs/Cube.prefab"), "utf8");
    expect(text).toContain(`guid: ${SPRITE_GUID}`);
    expect(text).not.toContain(OLD_SPRITE);
    expect(text).toContain("m_WasSpriteAssigned: 1");
    expect(splitUnityDocs(text).docs.filter((d) => d.classId === 212)).toHaveLength(1);
  });

  it("refuses a texture without a .meta, naming the way in", async () => {
    put("Assets/Prefabs/Pig.prefab", PREFAB_NO_RENDERER, PREFAB_GUID);
    put("Assets/Art/orphan.png", "png");
    const r = await new BindSpriteTool().execute({ target: "Assets/Prefabs/Pig.prefab", sprite: "Assets/Art/orphan.png" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("no .meta");
  });
});

describe("unity_place_prefab", () => {
  it("places the prefab as a scene root the delivery measurement counts", async () => {
    put("Assets/Prefabs/Pig.prefab", PREFAB_NO_RENDERER, PREFAB_GUID);
    put("Assets/Scenes/Main.unity", SCENE, "dddddddddddddddddddddddddddddddd");
    await new BindSpriteTool().execute({ target: "Assets/Prefabs/Pig.prefab", sprite: "Assets/Art/pig.png" }, ctx);
    const r = await new PlacePrefabTool().execute({ scene: "Assets/Scenes/Main.unity", prefab: "Assets/Prefabs/Pig.prefab", position: { x: 1, y: 2, z: 0 } }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("registered in SceneRoots");
    const text = readFileSync(join(root, "Assets/Scenes/Main.unity"), "utf8");
    expect(text).toContain(`m_SourcePrefab: {fileID: 100100000, guid: ${PREFAB_GUID}, type: 3}`);
    expect(text).toMatch(/propertyPath: m_LocalPosition\.y\n {6}value: 2/);
    expect(text.trimEnd().endsWith("}")).toBe(true); // SceneRoots stays last
    expect(prefabRoot(PREFAB_NO_RENDERER)).toEqual({ gameObjectId: "100", transformId: "400", name: "Pig" });

    // The measurement the campaign uses now sees a placed prefab with a renderer.
    const report = assessBuiltAsSpecified(root);
    const main = report.scenes.find((s) => s.scene === "Assets/Scenes/Main.unity")!;
    expect(main.prefabInstances).toBe(1);
    expect(main.renderersInPlacedPrefabs).toBe(1);
    expect(report.shippedRenderers).toBe(1);
    expect(report.refusal).toBeUndefined();
  });
});
