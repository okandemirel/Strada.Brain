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
    expect(prefabRoot(PREFAB_NO_RENDERER)).toEqual({ gameObjectId: "100", transformId: "400", transformClassId: 4, name: "Pig" });

    // The measurement the campaign uses now sees a placed prefab with a renderer.
    const report = assessBuiltAsSpecified(root);
    const main = report.scenes.find((s) => s.scene === "Assets/Scenes/Main.unity")!;
    expect(main.prefabInstances).toBe(1);
    expect(main.renderersInPlacedPrefabs).toBe(1);
    expect(report.shippedRenderers).toBe(1);
    expect(report.refusal).toBeUndefined();
  });
});

// ─── Codex (gpt-6-astra) adversarial review, 2026-09-07 ──────────────────

describe("defects the independent review found", () => {
  it("quotes an instance name YAML would misread, and keeps a plain one plain", async () => {
    const { yamlString, yamlScalar } = await import("./scene-binding.js");
    expect(yamlString("StradaProbeUfo")).toBe("StradaProbeUfo");
    expect(yamlString("Enemy: Red")).toBe('"Enemy: Red"');
    expect(yamlString("Enemy #1")).toBe('"Enemy #1"');
    expect(yamlScalar('"Enemy: Red"')).toBe("Enemy: Red");
    put("Assets/Prefabs/Pig.prefab", PREFAB_NO_RENDERER, PREFAB_GUID);
    put("Assets/Scenes/Main.unity", SCENE, "dddddddddddddddddddddddddddddddd");
    const r = await new PlacePrefabTool().execute({ scene: "Assets/Scenes/Main.unity", prefab: "Assets/Prefabs/Pig.prefab", name: "Enemy: Red" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(root, "Assets/Scenes/Main.unity"), "utf8")).toContain('value: "Enemy: Red"');
  });

  it("registers the root in an empty scene's inline `m_Roots: []`", async () => {
    put("Assets/Prefabs/Pig.prefab", PREFAB_NO_RENDERER, PREFAB_GUID);
    put("Assets/Scenes/Empty.unity", SCENE.replace("  m_Roots:\n  - {fileID: 501}\n", "  m_Roots: []\n"), "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    const r = await new PlacePrefabTool().execute({ scene: "Assets/Scenes/Empty.unity", prefab: "Assets/Prefabs/Pig.prefab" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("registered in SceneRoots");
    const text = readFileSync(join(root, "Assets/Scenes/Empty.unity"), "utf8");
    expect(text).toMatch(/m_Roots:\n  - \{fileID: \d+\}\n/);
  });

  it("gives a RectTransform root a stripped RectTransform, not a Transform", async () => {
    const uiPrefab = PREFAB_NO_RENDERER.replace("--- !u!4 &400\nTransform:", "--- !u!224 &400\nRectTransform:");
    put("Assets/Prefabs/Panel.prefab", uiPrefab, PREFAB_GUID);
    put("Assets/Scenes/Main.unity", SCENE, "dddddddddddddddddddddddddddddddd");
    expect(prefabRoot(uiPrefab).transformClassId).toBe(224);
    await new PlacePrefabTool().execute({ scene: "Assets/Scenes/Main.unity", prefab: "Assets/Prefabs/Panel.prefab" }, ctx);
    const text = readFileSync(join(root, "Assets/Scenes/Main.unity"), "utf8");
    expect(text).toMatch(/--- !u!224 &\d+ stripped\nRectTransform:/);
    expect(text).not.toMatch(/--- !u!4 &\d+ stripped\nTransform:\n  m_CorrespondingSourceObject: \{fileID: 400/);
  });

  it("keeps a sprite sheet's slices (spriteMode 2) instead of flattening it", async () => {
    writeFileSync(join(root, "Assets/Art/pig.png.meta"), `fileFormatVersion: 2\nguid: ${SPRITE_GUID}\nTextureImporter:\n  textureType: 0\n  spriteMode: 2\n`);
    put("Assets/Prefabs/Pig.prefab", PREFAB_NO_RENDERER, PREFAB_GUID);
    await new BindSpriteTool().execute({ target: "Assets/Prefabs/Pig.prefab", sprite: "Assets/Art/pig.png" }, ctx);
    const meta = readFileSync(join(root, "Assets/Art/pig.png.meta"), "utf8");
    expect(meta).toMatch(/textureType: 8/);
    expect(meta).toMatch(/spriteMode: 2/);
  });

  it("finds a GameObject whose serialized name is quoted", async () => {
    put("Assets/Prefabs/Pig.prefab", PREFAB_NO_RENDERER.replace("m_Name: Pig", 'm_Name: "Pig: Red"'), PREFAB_GUID);
    const r = await new BindSpriteTool().execute({ target: "Assets/Prefabs/Pig.prefab", sprite: "Assets/Art/pig.png", objectName: "Pig: Red" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('"Pig: Red"');
  });
});

// ─── Plan 2.14 / audit U6 / D53: sheet sprites are not all 21300000 ───────
//
// `unity_bind_sprite` wrote the literal fileID 21300000, which is the Sprite
// sub-asset id of a SINGLE-mode texture only. Every slice of a sheet has its
// own id, recorded in the .meta's internalIDToNameTable as
//   - first: { 213: <fileID> }
//     second: <spriteName>
// so binding a sheet slice by the constant pointed at the wrong sprite (or at
// no sprite at all, drawing nothing).

const SHEET_META = (guid: string, entries: readonly [string, string][]): string =>
  `fileFormatVersion: 2\nguid: ${guid}\nTextureImporter:\n  internalIDToNameTable:\n` +
  entries.map(([fileId, name]) => `  - first:\n      213: ${fileId}\n    second: ${name}\n`).join("") +
  `  externalObjects: {}\n  textureType: 0\n  spriteMode: 2\n`;

const SHEET_ENTRIES: [string, string][] = [
  ["21300000", "pig_idle"],
  ["21300002", "pig_walk"],
  ["21300004", "pig_jump"],
];

describe("sprite sheet fileIDs (2.14 / U6 / D53)", () => {
  it("binds a named sheet sprite to ITS fileID, not the 21300000 literal", async () => {
    writeFileSync(join(root, "Assets/Art/pig.png.meta"), SHEET_META(SPRITE_GUID, SHEET_ENTRIES));
    put("Assets/Prefabs/Pig.prefab", PREFAB_NO_RENDERER, PREFAB_GUID);
    const r = await new BindSpriteTool().execute(
      { target: "Assets/Prefabs/Pig.prefab", sprite: "Assets/Art/pig.png", spriteName: "pig_walk" },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("fileID 21300002");
    const text = readFileSync(join(root, "Assets/Prefabs/Pig.prefab"), "utf8");
    const sr = splitUnityDocs(text).docs.find((d) => d.classId === 212)!;
    expect(sr.text).toContain(`m_Sprite: {fileID: 21300002, guid: ${SPRITE_GUID}, type: 3}`);
    expect(sr.text).not.toContain("fileID: 21300000");
    // The slices survive the importer fix, so the ids stay resolvable.
    expect(readFileSync(join(root, "Assets/Art/pig.png.meta"), "utf8")).toMatch(/spriteMode: 2/);
  });

  it("still binds 21300000 for a single-sprite texture, named or not", async () => {
    put("Assets/Prefabs/Pig.prefab", PREFAB_NO_RENDERER, PREFAB_GUID);
    const bare = await new BindSpriteTool().execute({ target: "Assets/Prefabs/Pig.prefab", sprite: "Assets/Art/pig.png" }, ctx);
    expect(bare.isError).toBeFalsy();
    expect(readFileSync(join(root, "Assets/Prefabs/Pig.prefab"), "utf8")).toContain(`m_Sprite: {fileID: 21300000, guid: ${SPRITE_GUID}, type: 3}`);

    // A Single-mode meta that DOES record its one sprite resolves by name to the same id.
    writeFileSync(join(root, "Assets/Art/solo.png.meta"), SHEET_META(OLD_SPRITE, [["21300000", "solo"]]).replace("spriteMode: 2", "spriteMode: 1"));
    writeFileSync(join(root, "Assets/Art/solo.png"), "png-bytes");
    put("Assets/Prefabs/Solo.prefab", PREFAB_NO_RENDERER, PREFAB_GUID);
    const named = await new BindSpriteTool().execute(
      { target: "Assets/Prefabs/Solo.prefab", sprite: "Assets/Art/solo.png", spriteName: "solo" },
      ctx,
    );
    expect(named.isError).toBeFalsy();
    expect(readFileSync(join(root, "Assets/Prefabs/Solo.prefab"), "utf8")).toContain(`m_Sprite: {fileID: 21300000, guid: ${OLD_SPRITE}, type: 3}`);
  });

  it("refuses a sprite name the sheet does not hold, listing the names it does", async () => {
    writeFileSync(join(root, "Assets/Art/pig.png.meta"), SHEET_META(SPRITE_GUID, SHEET_ENTRIES));
    put("Assets/Prefabs/Pig.prefab", PREFAB_NO_RENDERER, PREFAB_GUID);
    const r = await new BindSpriteTool().execute(
      { target: "Assets/Prefabs/Pig.prefab", sprite: "Assets/Art/pig.png", spriteName: "pig_fly" },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('no sprite named "pig_fly"');
    expect(r.content).toContain("pig_idle, pig_walk, pig_jump");
    // Nothing was written: no renderer, no half-bound prefab.
    expect(splitUnityDocs(readFileSync(join(root, "Assets/Prefabs/Pig.prefab"), "utf8")).docs.filter((d) => d.classId === 212)).toHaveLength(0);
  });

  it("re-reads the fileID from the meta on every call — a re-slice renumbers the ids", async () => {
    writeFileSync(join(root, "Assets/Art/pig.png.meta"), SHEET_META(SPRITE_GUID, SHEET_ENTRIES));
    put("Assets/Prefabs/Pig.prefab", PREFAB_NO_RENDERER, PREFAB_GUID);
    const first = await new BindSpriteTool().execute(
      { target: "Assets/Prefabs/Pig.prefab", sprite: "Assets/Art/pig.png", spriteName: "pig_walk" },
      ctx,
    );
    expect(first.isError).toBeFalsy();
    expect(readFileSync(join(root, "Assets/Prefabs/Pig.prefab"), "utf8")).toContain("m_Sprite: {fileID: 21300002");

    // Unity re-sliced the sheet: pig_walk now lives at a different sub-asset id.
    writeFileSync(
      join(root, "Assets/Art/pig.png.meta"),
      SHEET_META(SPRITE_GUID, [["21300000", "pig_idle"], ["21300008", "pig_walk"], ["21300010", "pig_jump"]]),
    );
    const second = await new BindSpriteTool().execute(
      { target: "Assets/Prefabs/Pig.prefab", sprite: "Assets/Art/pig.png", spriteName: "pig_walk" },
      ctx,
    );
    expect(second.isError).toBeFalsy();
    expect(second.content).toContain("fileID 21300008");
    const text = readFileSync(join(root, "Assets/Prefabs/Pig.prefab"), "utf8");
    expect(text).toContain("m_Sprite: {fileID: 21300008");
    expect(text).not.toContain("fileID: 21300002");
    expect(splitUnityDocs(text).docs.filter((d) => d.classId === 212)).toHaveLength(1);
  });

  it("reads the table itself: inline `first: {213: n}`, an empty table, and a quoted name", async () => {
    const { spriteNameTable, resolveSpriteFileId } = await import("./scene-binding.js");
    expect(spriteNameTable(SHEET_META(SPRITE_GUID, SHEET_ENTRIES))).toEqual([
      { fileId: "21300000", name: "pig_idle" },
      { fileId: "21300002", name: "pig_walk" },
      { fileId: "21300004", name: "pig_jump" },
    ]);
    expect(spriteNameTable("TextureImporter:\n  internalIDToNameTable: []\n  spriteMode: 1\n")).toEqual([]);
    expect(spriteNameTable("TextureImporter:\n  internalIDToNameTable:\n  - first: {213: 21300006}\n    second: \"pig: red\"\n  spriteMode: 2\n")).toEqual([
      { fileId: "21300006", name: "pig: red" },
    ]);
    // A sheet with no name asked for refuses rather than guessing a slice.
    const metaPath = join(root, "Assets/Art/sheet.png.meta");
    writeFileSync(metaPath, SHEET_META(SPRITE_GUID, SHEET_ENTRIES));
    expect(() => resolveSpriteFileId(metaPath)).toThrow(/sprite SHEET with 3 sprites/);
  });
});
