import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { deflateSync } from "node:zlib";
import {
  assessBuiltAsSpecified,
  isPlaceholderGradePng,
  isScaffoldingScene,
  measureAudioClip,
  measurePngContent,
  parseUnityDocuments,
  readEnabledBuildScenes, asksForFlatArt } from "./built-as-specified.js";

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
      "public class PlayfieldBuilder { void Build() { GameObject.CreatePrimitive(PrimitiveType.Cube); GameObject.CreatePrimitive(PrimitiveType.Sphere); } }",
      "66666666666666666666666666666666",
    );

    const report = assessBuiltAsSpecified(root);

    expect(report.refusal).toBeDefined();
    expect(report.refusal).toContain("render NOTHING");
    // Names the scene…
    expect(report.refusal).toContain("Assets/Scenes/ProductionMain.unity");
    // …the counts…
    expect(report.refusal).toContain("0 world renderer components");
    // …and the unbound assets it found.
    expect(report.refusal).toContain("Assets/Prefabs/Ball.prefab");
    expect(report.refusal).toContain("Assets/Art/Models/Pig.fbx");
    expect(report.refusal).toContain("GameObject.CreatePrimitive");
    expect(report.refusal).toContain("unity_bind_sprite");
    expect(report.refusal).toContain("unity_place_prefab");
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
    expect(report.artInventory).toEqual({ prefabs: 0, models: 0, sprites: 0, placeholderSprites: 0, audio: 0, duplicateAudio: 0, shortAudio: 0 });
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

  it("records that the file walk was truncated instead of reporting a partial scan as whole", () => {
    // No silent caps: a truncated walk would call bound art unbound.
    const root = project();
    buildSettings(root, [{ path: "Assets/Scenes/Main.unity" }]);
    put(root, "Assets/Scenes/Main.unity", `${HEADER}${CAMERA(0)}`, "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5");
    put(root, "Assets/Prefabs/Pig.prefab", artPrefab("22222222222222222222222222222222"), "11111111111111111111111111111111");
    put(root, "Assets/Art/pig.png", "pixels", "22222222222222222222222222222222");

    const report = assessBuiltAsSpecified(root, undefined, { walkBudget: 2 });
    // Both walks are budgeted, and each says so in its own words.
    expect(report.incomplete.join("\n")).toContain("scene-and-script walk returned its maximum of 2 files");
    expect(report.incomplete.join("\n")).toContain("the art walk returned its maximum of 2 files");
  });

  it("records that no scene is enabled rather than passing silently", () => {
    const root = project();
    buildSettings(root, [{ path: "Assets/Scenes/Main.unity", enabled: false }]);
    const report = assessBuiltAsSpecified(root);
    expect(report.incomplete.join("\n")).toContain("lists no ENABLED scene");
    expect(report.refusal).toBeUndefined();
  });
});

describe("assessBuiltAsSpecified — the entry scene's own composition", () => {
  /**
   * Audited 2026-09-04 against the live PixelFlow project: the refusal said
   * "the shipped scenes render NOTHING ... 100 prefabs unbound" and seven
   * sprints in a row failed to act on it. The scene it had to fill held a
   * camera and a GameBootstrapper whose config listed no modules — two
   * GameObjects, no prefab instance — and nothing the sprint was told said so.
   */
  it("names how empty the entry scene is, in the refusal and the disclosures", () => {
    const root = project();
    buildSettings(root, [{ path: "Assets/Scenes/Main.unity" }]);
    put(
      root,
      "Assets/Scenes/Main.unity",
      `${HEADER}--- !u!1 &100\nGameObject:\n  m_Name: MainCamera\n${CAMERA(0)}` +
        `--- !u!1 &200\nGameObject:\n  m_Name: Bootstrap\n` +
        `--- !u!114 &201\nMonoBehaviour:\n  m_Script: {fileID: 11500000, guid: 703ceb5289d5847f5800cd363a983966, type: 3}\n` +
        `  m_EditorClassIdentifier: Strada.Core::Strada.Core.Bootstrap.GameBootstrapper\n`,
      "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
    );
    put(root, "Assets/Prefabs/Pig.prefab", artPrefab("22222222222222222222222222222222"), "11111111111111111111111111111111");
    put(root, "Assets/Art/pig.png", "pixels", "22222222222222222222222222222222");

    const report = assessBuiltAsSpecified(root);
    const entry = report.scenes[0]!;
    expect(entry.gameObjects).toBe(2);
    expect(entry.prefabInstances).toBe(0);
    expect(entry.scripts).toEqual(["GameBootstrapper"]);

    expect(report.refusal).toBeDefined();
    expect(report.refusal).toContain("2 GameObjects, 0 placed prefab instances, script GameBootstrapper");
    expect(report.disclosures.join("\n")).toContain(
      "The entry scene Assets/Scenes/Main.unity holds 2 GameObjects, 0 placed prefab instances, script GameBootstrapper.",
    );
  });

  it("counts the scene's OWN objects, not those inside the prefabs it places", () => {
    const root = project();
    buildSettings(root, [{ path: "Assets/Scenes/Main.unity" }]);
    put(
      root,
      "Assets/Scenes/Main.unity",
      `${HEADER}--- !u!1 &100\nGameObject:\n  m_Name: Root\n${prefabInstance("11111111111111111111111111111111")}`,
      "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
    );
    put(root, "Assets/Prefabs/Pig.prefab", artPrefab("22222222222222222222222222222222"), "11111111111111111111111111111111");
    put(root, "Assets/Art/pig.png", "pixels", "22222222222222222222222222222222");

    const entry = assessBuiltAsSpecified(root).scenes[0]!;
    // The placed Pig prefab holds a GameObject of its own; the scene's count
    // must stay 1, or "how full is this scene" answers with the prefab's guts.
    expect(entry.gameObjects).toBe(1);
    expect(entry.prefabInstances).toBe(1);
  });
});

// ─── Placeholder-grade art ────────────────────────────────────────────────

/** A valid RGBA PNG: flat colour compresses to a few hundred bytes, noise does not. */
function png(width: number, height: number, kind: "flat" | "noise"): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let seed = 7;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width * 4; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[y * (width * 4 + 1) + 1 + x] = kind === "flat" ? 0x80 : seed & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A standalone PNG chunk (length, type, data, crc) for splicing metadata into a fixture. */
function pngChunk(type: string, data: Buffer): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let c = 0xffffffff;
  for (const b of body) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, sum]);
}

function putBytes(root: string, rel: string, body: Buffer, guid: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  writeFileSync(`${abs}.meta`, `fileFormatVersion: 2\nguid: ${guid}\n`);
}

/** A scene that places one sprite renderer bound to project art — the shape that passes A and B. */
function boundSpriteProject(root: string, spriteGuid: string): void {
  buildSettings(root, [{ path: "Assets/Scenes/Main.unity" }]);
  put(
    root,
    "Assets/Scenes/Main.unity",
    `${HEADER}${CAMERA(0)}${prefabInstance("11111111111111111111111111111111")}`,
    "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
  );
  put(root, "Assets/Prefabs/Pig.prefab", artPrefab(spriteGuid), "11111111111111111111111111111111");
}

describe("assessBuiltAsSpecified — placeholder-grade art", () => {
  // Measured 2026-09-06 on the PixelFlow lease: 409 of 428 sprites were
  // 64×64 PNGs of ~281 bytes — procedural squares — and the gate counted them
  // as "428 sprite textures". A game whose art is 95% solid squares delivered.
  it("refuses when the sprite art is overwhelmingly flat shapes, naming counts, files and the tools", () => {
    const root = project();
    boundSpriteProject(root, "a0000000000000000000000000000000");
    putBytes(root, "Assets/Art/Generated/Pig.png", png(64, 64, "flat"), "a0000000000000000000000000000000");
    for (let i = 1; i <= 11; i++) {
      putBytes(root, `Assets/Art/Areas/SunnyFarm/Artwork_${i}.png`, png(64, 64, "flat"), `b${String(i).padStart(31, "0")}`);
    }
    putBytes(root, "Assets/Art/Real/Hero.png", png(64, 64, "noise"), "c0000000000000000000000000000000");

    const report = assessBuiltAsSpecified(root);

    expect(report.artInventory).toEqual({ prefabs: 1, models: 0, sprites: 13, placeholderSprites: 12, audio: 0, duplicateAudio: 0, shortAudio: 0 });
    expect(report.placeholderSpritePaths).not.toContain("Assets/Art/Real/Hero.png");
    expect(report.refusal).toBeDefined();
    expect(report.refusal).toContain("placeholder art: 12 of 13 sprite textures");
    expect(report.refusal).toContain("SAME name and the SAME path as the placeholder file");
    // …and what is real already, so the next sprint does not redraw it.
    expect(report.disclosures.join("\n")).toContain("1 are real art already (newest first: Assets/Art/Real/Hero.png)");
    expect(report.refusal).toContain("Assets/Art/Areas/SunnyFarm/Artwork_1.png");
    expect(report.refusal).toContain("unity_generate_sprite");
    expect(report.refusal).toContain("unity_my_assets_cloud");
  });

  it("names the placeholders a shipped scene binds FIRST, and says to replace those before wiring more", () => {
    // Measured 2026-09-07 22:40: a sprint wired six area-background prefabs to
    // placeholder PNGs while the refusal's examples were unbound LiveOps icons.
    const root = project();
    boundSpriteProject(root, "a0000000000000000000000000000000"); // Pig.prefab placed, sprite a000… bound
    putBytes(root, "Assets/Art/pig.png", png(64, 64, "flat"), "a0000000000000000000000000000000"); // bound AND a placeholder
    for (let i = 1; i <= 11; i++) {
      putBytes(root, `Assets/Art/LiveOps/Icon_${i}.png`, png(64, 64, "flat"), `b${String(i).padStart(31, "0")}`);
    }
    const report = assessBuiltAsSpecified(root);
    expect(report.boundPlaceholderSprites).toBe(1);
    expect(report.placeholderSpritePaths[0]).toBe("Assets/Art/pig.png");
    expect(report.refusal).toContain("1 of them are bound into the shipped scenes");
    expect(report.refusal).toContain("do not wire more placeholders");
    expect(report.refusal!.indexOf("Assets/Art/pig.png")).toBeLessThan(report.refusal!.indexOf("Icon_"));
  });

  it("only discloses when the placeholders are a minority", () => {
    const root = project();
    boundSpriteProject(root, "a0000000000000000000000000000000");
    putBytes(root, "Assets/Art/Real/Pig.png", png(64, 64, "noise"), "a0000000000000000000000000000000");
    for (let i = 1; i <= 8; i++) {
      putBytes(root, `Assets/Art/Real/Hero_${i}.png`, png(64, 64, "noise"), `c${String(i).padStart(31, "0")}`);
    }
    putBytes(root, "Assets/Art/Generated/Marker.png", png(64, 64, "flat"), "d0000000000000000000000000000000");

    const report = assessBuiltAsSpecified(root);

    expect(report.refusal).toBeUndefined();
    expect(report.artInventory.placeholderSprites).toBe(1);
    expect(report.disclosures.join("\n")).toContain("1 of the 10 sprite textures are placeholder-grade");
  });

  it("does not call a small or unreadable set placeholder art", () => {
    const root = project();
    boundSpriteProject(root, "a0000000000000000000000000000000");
    // Fewer than the minimum, and one is not even a PNG.
    putBytes(root, "Assets/Art/Generated/Pig.png", png(64, 64, "flat"), "a0000000000000000000000000000000");
    put(root, "Assets/Art/junk.png", "pixels", "e0000000000000000000000000000000");

    const report = assessBuiltAsSpecified(root);

    expect(report.refusal).toBeUndefined();
    expect(report.artInventory).toEqual({ prefabs: 1, models: 0, sprites: 2, placeholderSprites: 1, audio: 0, duplicateAudio: 0, shortAudio: 0 });
  });
});

// ─── Audio inventory ─────────────────────────────────────────────────────

/** A valid 16-bit mono 8 kHz WAV of `seconds` length, filled with `fill`. */
function wav(seconds: number, fill: number): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(Math.round(seconds * rate) * 2, fill);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe("assessBuiltAsSpecified — audio inventory", () => {
  // Measured 2026-09-07: 19 WAVs, thirteen of 0.15 s, four byte-identical
  // to another, counted nowhere.
  it("counts clips, duplicates by content and blips, and says so", () => {
    const root = project();
    boundSpriteProject(root, "a0000000000000000000000000000000");
    putBytes(root, "Assets/Art/Real/Pig.png", png(64, 64, "noise"), "a0000000000000000000000000000000");
    putBytes(root, "Assets/Audio/music_base_loop.wav", wav(3, 7), "d1000000000000000000000000000000");
    putBytes(root, "Assets/Audio/music_beach.wav", wav(3, 7), "d2000000000000000000000000000000"); // same bytes
    putBytes(root, "Assets/Audio/ui_click.wav", wav(0.15, 3), "d3000000000000000000000000000000");
    putBytes(root, "Assets/Audio/win.ogg", Buffer.from("OggS not really"), "d4000000000000000000000000000000");

    const report = assessBuiltAsSpecified(root);

    expect(report.artInventory.audio).toBe(4);
    expect(report.artInventory.duplicateAudio).toBe(1);
    expect(report.artInventory.shortAudio).toBe(1);
    const line = report.disclosures.find((d) => d.startsWith("Project audio"))!;
    expect(line).toContain("4 clips, 3 distinct by content");
    expect(line).toContain("music_beach.wav = Assets/Audio/music_base_loop.wav");
    expect(line).toContain("1 shorter than 0.5s");
    expect(line).toContain("ui_click.wav");
  });

  it("says when there is no audio at all", () => {
    const root = project();
    boundSpriteProject(root, "a0000000000000000000000000000000");
    putBytes(root, "Assets/Art/Real/Pig.png", png(64, 64, "noise"), "a0000000000000000000000000000000");
    expect(assessBuiltAsSpecified(root).disclosures).toContain("Project audio: no audio clips under Assets/ at all.");
  });
});

describe("defects the measurement review found (2026-09-07)", () => {
  const G = (n: string): string => n.repeat(32);
  const SPRITE_PREFAB_BUILTIN_MAT = (spriteRef: string): string =>
    `${HEADER}--- !u!1 &7\nGameObject:\n  m_Name: Thing\n` +
    `--- !u!212 &8\nSpriteRenderer:\n  m_Enabled: 1\n  m_Materials:\n  - {fileID: 10754, guid: 0000000000000000f000000000000000, type: 0}\n` +
    `  m_Sprite: ${spriteRef}\n`;

  it("a HUD CanvasRenderer does not lift the 'renders NOTHING' refusal", () => {
    const root = project();
    buildSettings(root, [{ path: "Assets/Scenes/Main.unity" }]);
    put(root, "Assets/Scenes/Main.unity",
      `${HEADER}${CAMERA(0)}--- !u!1 &30\nGameObject:\n  m_Name: Score\n--- !u!222 &31\nCanvasRenderer:\n  m_GameObject: {fileID: 30}\n`, G("5"));
    put(root, "Assets/Prefabs/Pig.prefab", artPrefab(G("2")), G("1"));
    put(root, "Assets/Art/pig.png", "pixels", G("2"));
    put(root, "Assets/Scripts/World.cs", "class W { void B() { GameObject.CreatePrimitive(PrimitiveType.Cube); GameObject.CreatePrimitive(PrimitiveType.Sphere); } }", G("6"));
    const report = assessBuiltAsSpecified(root);
    expect(report.shippedRenderers).toBe(1);
    expect(report.shippedWorldRenderers).toBe(0);
    expect(report.refusal).toContain("render NOTHING");
    expect(report.refusal).toContain("1 UI CanvasRenderer/VideoPlayer do not count");
  });

  it("a UI-driven game (a screen built from canvases, no primitives) is not 'renders NOTHING' (Codex 2026-09-11 B#16)", () => {
    const root = project();
    buildSettings(root, [{ path: "Assets/Scenes/Main.unity" }]);
    // Canvases BOUND to the project's own art: a card game's screen.
    const canvases = Array.from({ length: 12 }, (_, i) =>
      `--- !u!1 &${40 + i}\nGameObject:\n  m_Name: Card${i}\n--- !u!222 &${80 + i}\nCanvasRenderer:\n  m_GameObject: {fileID: ${40 + i}}\n` +
      `--- !u!114 &${120 + i}\nMonoBehaviour:\n  m_GameObject: {fileID: ${40 + i}}\n  m_Sprite: {fileID: 21300000, guid: ${G("2")}, type: 3}\n`).join("");
    put(root, "Assets/Scenes/Main.unity", `${HEADER}${CAMERA(0)}${canvases}`, G("5"));
    put(root, "Assets/Art/card.png", "pixels", G("2"));
    const report = assessBuiltAsSpecified(root);
    expect(report.shippedWorldRenderers).toBe(0);
    expect(report.shippedRenderers).toBe(12);
    expect(report.refusal).toBeUndefined();

    // Bare renderers with NOTHING in them are not a game (Codex 2026-09-11 C#16).
    const empty = project();
    buildSettings(empty, [{ path: "Assets/Scenes/Main.unity" }]);
    const bare = Array.from({ length: 12 }, (_, i) =>
      `--- !u!1 &${40 + i}\nGameObject:\n  m_Name: Blank${i}\n--- !u!222 &${80 + i}\nCanvasRenderer:\n  m_GameObject: {fileID: ${40 + i}}\n`).join("");
    put(empty, "Assets/Scenes/Main.unity", `${HEADER}${CAMERA(0)}${bare}`, G("5"));
    put(empty, "Assets/Art/unused.png", "pixels", G("2"));
    expect(assessBuiltAsSpecified(empty).refusal).toContain("render NOTHING");

    // …and the measured hole stays shut: canvases over engine primitives are
    // still a HUD over a world nobody made.
    const withPrimitives = project();
    buildSettings(withPrimitives, [{ path: "Assets/Scenes/Main.unity" }]);
    put(withPrimitives, "Assets/Scenes/Main.unity", `${HEADER}${CAMERA(0)}${canvases}`, G("5"));
    put(withPrimitives, "Assets/Prefabs/Pig.prefab", artPrefab(G("2")), G("1"));
    put(withPrimitives, "Assets/Art/thing.png", "pixels", G("2"));
    put(withPrimitives, "Assets/Scripts/World.cs", "class W { void B() { GameObject.CreatePrimitive(PrimitiveType.Cube); GameObject.CreatePrimitive(PrimitiveType.Sphere); } }", G("6"));
    expect(assessBuiltAsSpecified(withPrimitives).refusal).toContain("render NOTHING");
  });

  it("a DANGLING sprite GUID is not a UI binding, and a bound movie is a video game's picture (Codex 2026-09-11 D#26, D#27)", () => {
    // Three canvases whose sprite reference resolves to nothing.
    const dangling = project();
    buildSettings(dangling, [{ path: "Assets/Scenes/Main.unity" }]);
    const canvases = Array.from({ length: 3 }, (_, i) =>
      `--- !u!1 &${40 + i}\nGameObject:\n  m_Name: Card${i}\n--- !u!222 &${80 + i}\nCanvasRenderer:\n  m_GameObject: {fileID: ${40 + i}}\n` +
      `--- !u!114 &${120 + i}\nMonoBehaviour:\n  m_GameObject: {fileID: ${40 + i}}\n  m_Sprite: {fileID: 21300000, guid: ${G("f")}, type: 3}\n`).join("");
    put(dangling, "Assets/Scenes/Main.unity", `${HEADER}${CAMERA(0)}${canvases}`, G("5"));
    put(dangling, "Assets/Art/unbound.png", "pixels", G("2"));
    expect(assessBuiltAsSpecified(dangling).refusal).toContain("render NOTHING");

    // One VideoPlayer bound to a real movie: that IS the picture.
    const video = project();
    buildSettings(video, [{ path: "Assets/Scenes/Main.unity" }]);
    put(video, "Assets/Scenes/Main.unity",
      `${HEADER}${CAMERA(0)}--- !u!1 &30\nGameObject:\n  m_Name: Screen\n--- !u!328 &31\nVideoPlayer:\n  m_GameObject: {fileID: 30}\n  m_VideoClip: {fileID: 32900000, guid: ${G("9")}, type: 3}\n`, G("5"));
    put(video, "Assets/Movies/Intro.mp4", "movie-bytes", G("9"));
    // The project also holds cover art, so the "renders NOTHING despite art"
    // branch is live — that is the branch that refused video games.
    put(video, "Assets/Art/Cover.png", "pixels", G("8"));
    const report = assessBuiltAsSpecified(video);
    expect(report.scenes[0]!.videoClipsBound).toEqual(["Assets/Movies/Intro.mp4"]);
    expect(report.refusal).toBeUndefined();
  });

  it("an orphaned .meta does not resolve a sprite, and a switched-off video is not the picture (Codex 2026-09-11 E#6, E#12)", () => {
    // The sidecar carries the GUID the canvases reference; the PNG is gone.
    const orphaned = project();
    buildSettings(orphaned, [{ path: "Assets/Scenes/Main.unity" }]);
    const canvases = Array.from({ length: 3 }, (_, i) =>
      `--- !u!1 &${40 + i}\nGameObject:\n  m_Name: Card${i}\n--- !u!222 &${80 + i}\nCanvasRenderer:\n  m_GameObject: {fileID: ${40 + i}}\n` +
      `--- !u!114 &${120 + i}\nMonoBehaviour:\n  m_GameObject: {fileID: ${40 + i}}\n  m_Sprite: {fileID: 21300000, guid: ${G("f")}, type: 3}\n`).join("");
    put(orphaned, "Assets/Scenes/Main.unity", `${HEADER}${CAMERA(0)}${canvases}`, G("5"));
    put(orphaned, "Assets/Art/unbound.png", "pixels", G("2"));
    // Only the sidecar, never the asset.
    writeFileSync(join(orphaned, "Assets/Art/missing.png.meta"), `guid: ${G("f")}\n`);
    const report = assessBuiltAsSpecified(orphaned);
    expect(report.scenes[0]!.resolvedArtRefs).toBe(0);
    expect(report.refusal).toContain("render NOTHING");

    // Each switch ALONE is enough: the component disabled on a live object,
    // and the component enabled on a dead one.
    const videoScene = (active: string, enabled: string): string =>
      `${HEADER}${CAMERA(0)}--- !u!1 &30\nGameObject:\n  m_Name: Screen\n  m_IsActive: ${active}\n` +
      `--- !u!328 &31\nVideoPlayer:\n  m_GameObject: {fileID: 30}\n  m_Enabled: ${enabled}\n  m_VideoClip: {fileID: 32900000, guid: ${G("9")}, type: 3}\n`;
    for (const [active, enabled] of [["1", "0"], ["0", "1"]] as const) {
      const off = project();
      buildSettings(off, [{ path: "Assets/Scenes/Main.unity" }]);
      put(off, "Assets/Scenes/Main.unity", videoScene(active, enabled), G("5"));
      put(off, "Assets/Movies/Intro.mp4", "movie-bytes", G("9"));
      put(off, "Assets/Art/Cover.png", "pixels", G("8"));
      const offReport = assessBuiltAsSpecified(off);
      expect(offReport.scenes[0]!.videoClipsBound).toEqual([]);
      expect(offReport.refusal).toContain("render NOTHING");
    }

    // …and the enabled one still is the picture.
    const on = project();
    buildSettings(on, [{ path: "Assets/Scenes/Main.unity" }]);
    put(on, "Assets/Scenes/Main.unity",
      `${HEADER}${CAMERA(0)}--- !u!1 &30\nGameObject:\n  m_Name: Screen\n  m_IsActive: 1\n--- !u!328 &31\nVideoPlayer:\n  m_GameObject: {fileID: 30}\n  m_Enabled: 1\n  m_VideoClip: {fileID: 32900000, guid: ${G("9")}, type: 3}\n`, G("5"));
    put(on, "Assets/Movies/Intro.mp4", "movie-bytes", G("9"));
    put(on, "Assets/Art/Cover.png", "pixels", G("8"));
    expect(assessBuiltAsSpecified(on).refusal).toBeUndefined();
  });

  it("flat artwork the GDD ASKED for is a style, not placeholder art (Codex 2026-09-11 B#17)", () => {
    const root = project();
    boundSpriteProject(root, "a0000000000000000000000000000000");
    putBytes(root, "Assets/Art/Generated/Card.png", png(64, 64, "flat"), "a0000000000000000000000000000000");
    for (let i = 1; i <= 11; i++) {
      putBytes(root, `Assets/Art/Cards/Card_${i}.png`, png(64, 64, "flat"), `b${String(i).padStart(31, "0")}`);
    }
    // The pixels are identical; only the document differs.
    expect(assessBuiltAsSpecified(root).refusal).toContain("placeholder art");
    const asked = assessBuiltAsSpecified(root, undefined, {
      artDirection: "A minimalist geometric look: solid colour shapes, no gradients, no texture detail anywhere.",
    });
    expect(asked.refusal ?? "").not.toContain("placeholder art");
    // The counts are still disclosed — the style is honoured, not hidden.
    expect(asked.disclosures.join(" ")).toContain("placeholder-grade");
  });

  it("a NEGATED flat phrase does not grant the flat-art exemption (Codex 2026-09-11 C#18)", () => {
    expect(asksForFlatArt("A minimalist geometric look: solid colour shapes everywhere.")).toBe(true);
    expect(asksForFlatArt("Never use flat art; every object must have detailed painted texture.")).toBe(false);
    expect(asksForFlatArt("No flat shading anywhere — everything is hand-painted.")).toBe(false);
    // A flat phrase about the INTERFACE says nothing about the artwork (D#25).
    expect(asksForFlatArt("A minimal UI over lush painted scenes.")).toBe(false);
    expect(asksForFlatArt("Use minimalist UI over richly painted character art.")).toBe(false);
    // …and a negation does not spill across punctuation (D#25).
    expect(asksForFlatArt("Do not use gradients; use flat art.")).toBe(true);
  });

  it("a PrefabInstance of an imported model is a placed, project-bound mesh", () => {
    const root = project();
    buildSettings(root, [{ path: "Assets/Scenes/Main.unity" }]);
    put(root, "Assets/Scenes/Main.unity", `${HEADER}${CAMERA(0)}${prefabInstance(G("a"), 1001)}${prefabInstance(G("b"), 1002)}`, G("5"));
    put(root, "Assets/Models/Tree.fbx", "binary", G("a"));
    put(root, "Assets/Models/House.fbx", "binary", G("b"));
    const report = assessBuiltAsSpecified(root);
    expect(report.refusal).toBeUndefined();
    expect(report.shippedRenderers).toBe(2);
    expect(report.scenes[0]!.modelsBound.sort()).toEqual(["Assets/Models/House.fbx", "Assets/Models/Tree.fbx"]);
    expect(report.scenes[0]!.unresolvedPrefabGuids).toEqual([]);
    expect(report.unboundModels).toEqual([]);
  });

  it("a Resources.Load game is referenced by name, not refused as unbound", () => {
    const root = project();
    buildSettings(root, [{ path: "Assets/Scenes/Main.unity" }]);
    put(root, "Assets/Scenes/Main.unity", `${HEADER}${CAMERA(0)}--- !u!114 &500\nMonoBehaviour:\n  m_EditorClassIdentifier: Assembly-CSharp::Spawner\n`, G("5"));
    put(root, "Assets/Resources/Prefabs/Pig.prefab", artPrefab(G("2")), G("1"));
    put(root, "Assets/Art/pig.png", "pixels", G("2"));
    put(root, "Assets/Scripts/Spawner.cs", "class Spawner { void S() { Instantiate(Resources.Load(\"Prefabs/Pig\")); } }", G("6"));
    const report = assessBuiltAsSpecified(root);
    expect(report.refusal).toBeUndefined();
    expect(report.referencedOnlyRenderers).toBe(1);
    expect(report.unboundPrefabs).toEqual([]);
    expect(report.unboundSprites).toEqual([]);
  });

  it("a Tilemap's tiles, a UI Image's sprite and a PrefabInstance override are project bindings", () => {
    const root = project();
    buildSettings(root, [{ path: "Assets/Scenes/Level1.unity" }]);
    put(root, "Assets/Scenes/Level1.unity",
      `${HEADER}${CAMERA(0)}--- !u!1 &200\nGameObject:\n  m_Name: Ground\n` +
      `--- !u!1839735485 &201\nTilemap:\n  m_Tiles:\n  - first: {x: 0, y: 0, z: 0}\n    second:\n      m_TileIndex: 0\n  m_TileAssetArray:\n  - m_RefCount: 1\n    m_Data: {fileID: 11400000, guid: ${G("2")}, type: 2}\n  m_TileSpriteArray:\n  - m_RefCount: 1\n    m_Data: {fileID: 21300000, guid: ${G("3")}, type: 3}\n` +
      `--- !u!483693784 &202\nTilemapRenderer:\n  m_Enabled: 1\n  m_Materials:\n  - {fileID: 10754, guid: 0000000000000000f000000000000000, type: 0}\n` +
      `--- !u!114 &203\nMonoBehaviour:\n  m_EditorClassIdentifier: UnityEngine.UI::UnityEngine.UI.Image\n  m_Sprite: {fileID: 21300000, guid: ${G("8")}, type: 3}\n` +
      `--- !u!1001 &1001\nPrefabInstance:\n  m_Modification:\n    m_Modifications:\n    - target: {fileID: 8, guid: ${G("1")}, type: 3}\n      propertyPath: m_Sprite\n      value: \n      objectReference: {fileID: 21300000, guid: ${G("4")}, type: 3}\n  m_SourcePrefab: {fileID: 100100000, guid: ${G("1")}, type: 3}\n`,
      G("5"));
    put(root, "Assets/Tiles/Grass.asset", `${HEADER}--- !u!114 &11400000\nMonoBehaviour:\n  m_Sprite: {fileID: 21300000, guid: ${G("3")}, type: 3}\n`, G("2"));
    put(root, "Assets/Art/grass.png", "pixels", G("3"));
    put(root, "Assets/Art/hud.png", "pixels", G("8"));
    put(root, "Assets/Prefabs/SpriteObject.prefab", SPRITE_PREFAB_BUILTIN_MAT("{fileID: 0}"), G("1"));
    put(root, "Assets/Art/player.png", "pixels", G("4"));
    put(root, "Assets/Art/unused_concept.png", "pixels", G("9"));
    const report = assessBuiltAsSpecified(root);
    expect(report.refusal).toBeUndefined();
    expect(report.shippedProjectRefs).toBeGreaterThanOrEqual(3);
    expect(report.unboundSprites).toEqual(["Assets/Art/unused_concept.png"]);
  });

  it("follows materials and animation clips to the textures they bind", () => {
    const root = project();
    buildSettings(root, [{ path: "Assets/Scenes/Main.unity" }]);
    put(root, "Assets/Scenes/Main.unity", `${HEADER}${CAMERA(0)}${prefabInstance(G("1"))}`, G("5"));
    put(root, "Assets/Prefabs/Tree.prefab",
      `${HEADER}--- !u!1 &7\nGameObject:\n  m_Name: Tree\n--- !u!33 &9\nMeshFilter:\n  m_Mesh: {fileID: 4300000, guid: ${G("a")}, type: 3}\n` +
      `--- !u!23 &8\nMeshRenderer:\n  m_Enabled: 1\n  m_Materials:\n  - {fileID: 2100000, guid: ${G("c")}, type: 2}\n`, G("1"));
    put(root, "Assets/Models/Tree.fbx", "binary", G("a"));
    put(root, "Assets/Materials/Bark.mat", `${HEADER}--- !u!21 &2100000\nMaterial:\n  m_SavedProperties:\n    m_TexEnvs:\n    - _MainTex:\n        m_Texture: {fileID: 2800000, guid: ${G("d")}, type: 3}\n`, G("c"));
    put(root, "Assets/Textures/bark.png", "pixels", G("d"));
    const report = assessBuiltAsSpecified(root);
    expect(report.refusal).toBeUndefined();
    expect(report.unboundSprites).toEqual([]);
  });

  it("reads CRLF files, skips stripped documents, counts Terrain, and names a missing entry scene", () => {
    const crlf = `${HEADER}${CAMERA(0)}${prefabInstance(G("1"))}--- !u!212 &88 stripped\nSpriteRenderer:\n  m_PrefabInstance: {fileID: 1001}\n`.replace(/\n/g, "\r\n");
    expect(parseUnityDocuments(crlf).map((d) => d.className)).toEqual(["Camera", "PrefabInstance"]);
    const root = project();
    buildSettings(root, [{ path: "Assets/Scenes/Main.unity" }]);
    put(root, "Assets/Scenes/Main.unity", crlf, G("5"));
    put(root, "Assets/Prefabs/Pig.prefab", artPrefab(G("2")), G("1"));
    put(root, "Assets/Art/pig.png", "pixels", G("2"));
    const report = assessBuiltAsSpecified(root);
    expect(report.refusal).toBeUndefined();
    expect(report.shippedRenderers).toBe(1); // not 2: the stripped doc is the same renderer
    expect(report.scenes[0]!.camerasPerspective).toBe(1);

    const terrain = project();
    buildSettings(terrain, [{ path: "Assets/Scenes/World.unity" }]);
    put(terrain, "Assets/Scenes/World.unity", `${HEADER}${CAMERA(0)}--- !u!218 &40\nTerrain:\n  m_TerrainData: {fileID: 15600000, guid: ${G("e")}, type: 2}\n`, G("5"));
    put(terrain, "Assets/Terrain/World.asset", "TerrainData", G("e"));
    put(terrain, "Assets/Art/rock.png", "pixels", G("9"));
    const t = assessBuiltAsSpecified(terrain);
    expect(t.refusal).toBeUndefined();
    expect(t.shippedRenderers).toBe(1);

    const missing = project();
    buildSettings(missing, [{ path: "Assets/Scenes/Gone.unity" }, { path: "Assets/Scenes/Main.unity" }]);
    put(missing, "Assets/Scenes/Main.unity", `${HEADER}${CAMERA(0)}`, G("5"));
    put(missing, "Assets/Art/pig.png", "pixels", G("2"));
    expect(assessBuiltAsSpecified(missing).refusal).toContain("Gone.unity — missing from disk");
  });

  it("one CreatePrimitive call site beside referenced art is a disclosure; two are the world", () => {
    const build = (calls: number): string => {
      const root = project();
      buildSettings(root, [{ path: "Assets/Scenes/Main.unity" }]);
      put(root, "Assets/Scenes/Main.unity", `${HEADER}${CAMERA(0)}--- !u!114 &500\nMonoBehaviour:\n  _config: {fileID: 11400000, guid: ${G("c")}, type: 2}\n`, G("5"));
      put(root, "Assets/Settings/Config.asset", `${HEADER}--- !u!114 &11400000\nMonoBehaviour:\n  _pig: {fileID: 7, guid: ${G("1")}, type: 3}\n`, G("c"));
      put(root, "Assets/Prefabs/Pig.prefab", artPrefab(G("2")), G("1"));
      put(root, "Assets/Art/pig.png", "pixels", G("2"));
      put(root, "Assets/Scripts/Fader.cs", `class Fader { void F() { ${"GameObject.CreatePrimitive(PrimitiveType.Quad); ".repeat(calls)} } }`, G("6"));
      return assessBuiltAsSpecified(root).refusal ?? "none";
    };
    expect(build(1)).toBe("none");
    expect(build(2)).toContain("render NOTHING");
  });

  it("a WAV whose data size is 0 (streamed) runs to the end of the file", () => {
    const root = project();
    const clip = wav(90, 3);
    clip.writeUInt32LE(0, 40);
    putBytes(root, "Assets/Audio/stream.wav", clip, G("d"));
    expect(measureAudioClip(join(root, "Assets/Audio/stream.wav")).seconds).toBeCloseTo(90, 2);
  });

  it("placeholder grade is what the pixels say, not what the file weighs", () => {
    // Flat shapes: few colours, edges only on outlines — whatever the encoder does.
    const root = project();
    const flat = png(64, 64, "flat");
    const flatWithText = Buffer.concat([flat.subarray(0, 33), pngChunk("tEXt", Buffer.alloc(3000, 0x41)), flat.subarray(33)]);
    putBytes(root, "Assets/Art/flat.png", flat, G("1"));
    putBytes(root, "Assets/Art/flat_text.png", flatWithText, G("2"));
    putBytes(root, "Assets/Art/noise.png", png(64, 64, "noise"), G("3"));
    putBytes(root, "Assets/Art/noise_big.png", png(512, 512, "noise"), G("4"));
    expect(isPlaceholderGradePng(join(root, "Assets/Art/flat.png"))).toBe(true);
    expect(isPlaceholderGradePng(join(root, "Assets/Art/flat_text.png"))).toBe(true); // 3 KB of metadata changes nothing
    expect(isPlaceholderGradePng(join(root, "Assets/Art/noise.png"))).toBe(false);
    expect(isPlaceholderGradePng(join(root, "Assets/Art/noise_big.png"))).toBe(false); // 0.0x bytes/pixel, still art
    const content = measurePngContent(flat)!;
    expect(content.colours).toBeLessThanOrEqual(2);
    expect(measurePngContent(png(64, 64, "noise"))!.colours).toBeGreaterThan(12);
  });
});
