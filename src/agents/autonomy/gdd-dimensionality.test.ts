import { describe, expect, it, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { assessBuiltAsSpecified } from "./built-as-specified.js";
import { describeDimensionality } from "./gdd-dimensionality.js";

/**
 * The GDD's own dimensionality, measured against the shipped scenes.
 *
 * Audited 2026-09-03: the GDD asked for "plump, glossy 3D-feel pigs" and the
 * delivered scenes had no mesh renderers and bound none of the project's 62
 * imported models. Disclosure, never refusal — a 3D-feel look built from
 * sprites is a legitimate choice, and only the counts can tell the reader
 * which one they got.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(os.tmpdir(), "gdd-dimensionality-"));
  roots.push(root);
  mkdirSync(join(root, "Assets"), { recursive: true });
  return root;
}

function put(root: string, rel: string, body: string, guid?: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  if (guid) writeFileSync(`${abs}.meta`, `fileFormatVersion: 2\nguid: ${guid}\n`);
}

function buildSettings(root: string, scenes: string[]): void {
  const body = scenes
    .map((p, i) => `  - enabled: 1\n    path: ${p}\n    guid: ${String(i).padStart(32, "a")}\n`)
    .join("");
  put(root, "ProjectSettings/EditorBuildSettings.asset", `EditorBuildSettings:\n  m_Scenes:\n${body}`);
}

const HEADER = "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n";
const CAMERA = (orthographic: 0 | 1): string =>
  `--- !u!20 &900\nCamera:\n  m_Enabled: 1\n  orthographic: ${orthographic}\n  orthographic size: 5\n`;
const prefabInstance = (guid: string): string =>
  `--- !u!1001 &1001\nPrefabInstance:\n  m_Modification:\n    m_Modifications: []\n  m_SourcePrefab: {fileID: 100100000, guid: ${guid}, type: 3}\n`;
const artPrefab = (spriteGuid: string): string =>
  `${HEADER}--- !u!1 &7\nGameObject:\n  m_Name: Pig\n` +
  `--- !u!212 &8\nSpriteRenderer:\n  m_Enabled: 1\n  m_Materials:\n  - {fileID: 2100000, guid: aaaabbbbccccddddeeeeffff00001111, type: 2}\n` +
  `  m_Sprite: {fileID: 21300000, guid: ${spriteGuid}, type: 3}\n`;
/** A prefab that really does draw 3D: a MeshFilter bound to an imported .fbx. */
const modelPrefab = (modelGuid: string): string =>
  `${HEADER}--- !u!1 &7\nGameObject:\n  m_Name: Pig\n` +
  `--- !u!33 &9\nMeshFilter:\n  m_Mesh: {fileID: 4300000, guid: ${modelGuid}, type: 3}\n` +
  `--- !u!23 &8\nMeshRenderer:\n  m_Enabled: 1\n  m_Materials:\n  - {fileID: 2100000, guid: aaaabbbbccccddddeeeeffff00001111, type: 2}\n`;

function spriteProject(): ReturnType<typeof assessBuiltAsSpecified> {
  const root = project();
  buildSettings(root, ["Assets/Scenes/Main.unity"]);
  put(
    root,
    "Assets/Scenes/Main.unity",
    `${HEADER}${CAMERA(0)}${prefabInstance("11111111111111111111111111111111")}`,
    "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
  );
  put(root, "Assets/Prefabs/Pig.prefab", artPrefab("22222222222222222222222222222222"), "11111111111111111111111111111111");
  put(root, "Assets/Art/pig.png", "pixels", "22222222222222222222222222222222");
  return assessBuiltAsSpecified(root);
}

describe("describeDimensionality", () => {
  const unmeasurable = assessBuiltAsSpecified("/definitely/not/a/project");

  it("discloses the counts when the GDD asks for 3D and the scenes are sprites", () => {
    const gdd = "12. ART DIRECTION\nplump, glossy 3D-feel pigs on softly rendered dimensional stages.";
    const d = describeDimensionality(gdd, spriteProject());

    expect(d.asksFor3D).toBe(true);
    const text = d.lines.join("\n");
    expect(text).toContain("The GDD asks for 3D");
    expect(text).toContain("0 mesh renderer(s)");
    expect(text).toContain("bind 0 imported model(s)");
    expect(text).toContain("1 sprite renderer(s)");
    // Cheap and factual, so it is always there.
    expect(text).toContain("Camera projection in the shipped scenes: 0 orthographic, 1 perspective");
    // Disclosure, never a verdict.
    expect(text).toContain("not a verdict");
  });

  it("counts the 3D geometry a scene really does bind", () => {
    const root = project();
    buildSettings(root, ["Assets/Scenes/Main.unity"]);
    put(
      root,
      "Assets/Scenes/Main.unity",
      `${HEADER}${CAMERA(0)}${prefabInstance("11111111111111111111111111111111")}`,
      "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
    );
    put(root, "Assets/Prefabs/Pig.prefab", modelPrefab("22222222222222222222222222222222"), "11111111111111111111111111111111");
    put(root, "Assets/Art/Models/pig.fbx", "binary", "22222222222222222222222222222222");

    const d = describeDimensionality("The pigs are 3D.", assessBuiltAsSpecified(root));
    expect(d.lines.join("\n")).toContain("1 mesh renderer(s) and bind 1 imported model(s)");
  });

  it("counts every mention and quotes each, so a table-of-contents line cannot pass as the statement", () => {
    const gdd = "CONTENTS\n  12.1 3D look ......... 40\n\n12.1 3D look\nThe pigs are 3D models on 3D stages.";
    const d = describeDimensionality(gdd, spriteProject());

    expect(d.signals.find((s) => s.term === "3D")?.count).toBe(4);
    // Both recorded excerpts are shown; the reader can see one is a contents line.
    expect(d.lines.filter((l) => l.startsWith("GDD says:"))).toHaveLength(2);
    expect(d.lines.join("\n")).toContain("CONTENTS");
  });

  it("reports an orthographic camera and a GDD that does not state 3D", () => {
    const root = project();
    buildSettings(root, ["Assets/Scenes/Main.unity"]);
    put(root, "Assets/Scenes/Main.unity", `${HEADER}${CAMERA(1)}`, "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5");
    const d = describeDimensionality("The game is 2D, orthographic.", assessBuiltAsSpecified(root));

    expect(d.asksFor3D).toBe(false);
    expect(d.signals.map((s) => s.term)).toEqual(["2D", "orthographic"]);
    expect(d.lines.join("\n")).toContain("The GDD does not state 3D");
    expect(d.lines.join("\n")).toContain("1 orthographic, 0 perspective");
  });

  it("says the GDD stated nothing rather than implying a match", () => {
    const d = describeDimensionality("A game about pigs.", unmeasurable);
    expect(d.signals).toEqual([]);
    expect(d.lines.join("\n")).toContain("states none of");
  });

  it("says the comparison was NOT made when the GDD is unreadable", () => {
    expect(describeDimensionality(undefined, unmeasurable).lines.join("\n")).toContain("NOT checked");
  });

  it("says the comparison was NOT made when the scenes could not be measured", () => {
    const d = describeDimensionality("Fully 3D.", unmeasurable);
    expect(d.asksFor3D).toBe(true);
    expect(d.lines.join("\n")).toContain("NOT made");
  });
});
