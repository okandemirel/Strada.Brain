/**
 * Deterministic last-mile binding — the two operations every delivery gate
 * refusal asked for and no tool could do without the Editor:
 *
 *   unity_bind_sprite   — point a GameObject's SpriteRenderer at a sprite
 *                         (adding the renderer if the object has none)
 *   unity_place_prefab  — put a prefab instance into a scene as a root object
 *
 * Measured 2026-09-07: eight remediation attempts, hours each, on "the shipped
 * scenes render NOTHING: 0 renderer components … 3 scripts call
 * CreatePrimitive". The agents had real sprites and real prefabs and no way to
 * connect them except hand-written YAML (forbidden — a reference with the
 * wrong `type:` reads as present and is null at runtime) or an Editor batch
 * (unity_scene_build, minutes per run, coupled to the compile). These edit the
 * serialized files directly, in Unity 6's own shapes, and verify by re-reading
 * what they wrote — the same way the delivery measurement will read it.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { ITool, ToolContext, ToolExecutionResult } from "../tool.interface.js";
import { validatePath } from "../../../security/path-guard.js";

// ─── Unity YAML documents ─────────────────────────────────────────────────

export interface UnityDoc {
  /** e.g. 212 for SpriteRenderer, 1 for GameObject, 4 for Transform, 1001 for PrefabInstance. */
  readonly classId: number;
  readonly fileId: string;
  readonly stripped: boolean;
  /** Text from the `--- !u!` header line (inclusive) to the next header (exclusive). */
  text: string;
}

const HEADER_RE = /^--- !u!(\d+) &(-?\d+)( stripped)?\s*$/;

/** Split a .unity/.prefab into its preamble and documents, preserving text exactly. */
export function splitUnityDocs(text: string): { preamble: string; docs: UnityDoc[] } {
  const lines = text.split("\n");
  const docs: UnityDoc[] = [];
  let preamble: string[] = [];
  let current: { classId: number; fileId: string; stripped: boolean; lines: string[] } | null = null;
  for (const line of lines) {
    const m = HEADER_RE.exec(line);
    if (m) {
      if (current) docs.push({ classId: current.classId, fileId: current.fileId, stripped: current.stripped, text: current.lines.join("\n") + "\n" });
      current = { classId: Number(m[1]), fileId: m[2]!, stripped: m[3] !== undefined, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) {
    // The last document keeps whatever trailing newline the file had.
    docs.push({ classId: current.classId, fileId: current.fileId, stripped: current.stripped, text: current.lines.join("\n") });
  }
  return { preamble: preamble.join("\n") + (preamble.length ? "\n" : ""), docs };
}

export function joinUnityDocs(preamble: string, docs: readonly UnityDoc[]): string {
  let out = preamble;
  for (const [i, d] of docs.entries()) {
    out += d.text;
    if (i < docs.length - 1 && !d.text.endsWith("\n")) out += "\n";
  }
  return out.endsWith("\n") ? out : out + "\n";
}

function field(doc: UnityDoc, name: string): string | undefined {
  const m = new RegExp(`^  ${name}: (.*?)\\r?$`, "m").exec(doc.text);
  return m?.[1] === undefined ? undefined : yamlScalar(m[1].trim());
}

/** A YAML plain/quoted scalar as Unity writes it → its string value. */
export function yamlScalar(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

/** A string value as a YAML scalar Unity will read back unchanged (quoted when it needs to be). */
export function yamlString(value: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_ .\-]*$/.test(value) && !/\s$/.test(value) ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function refFileId(value: string | undefined): string | undefined {
  const m = value ? /fileID: (-?\d+)/.exec(value) : null;
  return m?.[1];
}

/** A fresh, positive, 63-bit file id not already used in the file. */
export function freshFileId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = (randomBytes(8).readBigUInt64BE() & ((1n << 62n) - 1n)).toString();
    if (id !== "0" && !taken.has(id)) return id;
  }
}

export function metaGuid(metaPath: string): string | undefined {
  try {
    const m = /^guid: ([0-9a-f]{32})$/m.exec(readFileSync(metaPath, "utf8"));
    return m?.[1];
  } catch {
    return undefined;
  }
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.strada-tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

// ─── SpriteRenderer ───────────────────────────────────────────────────────

/** Unity 6000.3 SpriteRenderer, as the Editor serializes it (copied from a project file, 2026-09-07). */
export function spriteRendererDoc(fileId: string, gameObjectId: string, spriteGuid: string, sortingOrder = 0): string {
  return `--- !u!212 &${fileId}
SpriteRenderer:
  serializedVersion: 2
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_GameObject: {fileID: ${gameObjectId}}
  m_Enabled: 1
  m_CastShadows: 0
  m_ReceiveShadows: 0
  m_DynamicOccludee: 1
  m_StaticShadowCaster: 0
  m_MotionVectors: 1
  m_LightProbeUsage: 1
  m_ReflectionProbeUsage: 1
  m_RayTracingMode: 0
  m_RayTraceProcedural: 0
  m_RayTracingAccelStructBuildFlagsOverride: 0
  m_RayTracingAccelStructBuildFlags: 1
  m_SmallMeshCulling: 1
  m_ForceMeshLod: -1
  m_MeshLodSelectionBias: 0
  m_RenderingLayerMask: 1
  m_RendererPriority: 0
  m_Materials:
  - {fileID: 10754, guid: 0000000000000000f000000000000000, type: 0}
  m_StaticBatchInfo:
    firstSubMesh: 0
    subMeshCount: 0
  m_StaticBatchRoot: {fileID: 0}
  m_ProbeAnchor: {fileID: 0}
  m_LightProbeVolumeOverride: {fileID: 0}
  m_ScaleInLightmap: 1
  m_ReceiveGI: 1
  m_PreserveUVs: 0
  m_IgnoreNormalsForChartDetection: 0
  m_ImportantGI: 0
  m_StitchLightmapSeams: 1
  m_SelectedEditorRenderState: 0
  m_MinimumChartSize: 4
  m_AutoUVMaxDistance: 0.5
  m_AutoUVMaxAngle: 89
  m_LightmapParameters: {fileID: 0}
  m_GlobalIlluminationMeshLod: 0
  m_SortingLayerID: 0
  m_SortingLayer: 0
  m_SortingOrder: ${sortingOrder}
  m_MaskInteraction: 0
  m_Sprite: {fileID: 21300000, guid: ${spriteGuid}, type: 3}
  m_Color: {r: 1, g: 1, b: 1, a: 1}
  m_FlipX: 0
  m_FlipY: 0
  m_DrawMode: 0
  m_Size: {x: 1, y: 1}
  m_AdaptiveModeThreshold: 0.5
  m_SpriteTileMode: 0
  m_WasSpriteAssigned: 1
  m_SpriteSortPoint: 0
`;
}

/** The sprite reference a SpriteRenderer holds for a single-sprite texture. */
export function spriteRef(guid: string): string {
  return `{fileID: 21300000, guid: ${guid}, type: 3}`;
}

/**
 * Make a texture's .meta import as a Sprite. A PNG imported as a plain
 * Texture has no Sprite sub-asset; a renderer pointed at it draws nothing.
 * Returns whether the meta was changed.
 */
export function ensureSpriteImporter(metaPath: string): boolean {
  const text = readFileSync(metaPath, "utf8");
  if (/^\s*textureType: 8\r?$/m.test(text) && /^\s*spriteMode: [12]\r?$/m.test(text)) return false;
  let next = text.replace(/^(\s*)textureType: \d+(\r?)$/m, "$1textureType: 8$2");
  // A sheet (spriteMode 2) keeps its slices; only a non-sprite mode becomes Single.
  if (!/^\s*spriteMode: 2\r?$/m.test(next)) next = next.replace(/^(\s*)spriteMode: \d+(\r?)$/m, "$1spriteMode: 1$2");
  if (next === text) return false;
  writeAtomic(metaPath, next);
  return true;
}

export interface BindSpriteResult {
  readonly gameObject: string;
  readonly rendererFileId: string;
  readonly added: boolean;
  readonly importerFixed: boolean;
}

/**
 * Point the named GameObject's SpriteRenderer at the sprite; add a renderer
 * when it has none. Verified by re-reading the file.
 */
export function bindSprite(
  targetPath: string,
  spriteGuid: string,
  opts: { objectName?: string; addRenderer?: boolean } = {},
): BindSpriteResult {
  const original = readFileSync(targetPath, "utf8");
  const { preamble, docs } = splitUnityDocs(original);
  const gameObjects = docs.filter((d) => d.classId === 1 && !d.stripped);
  if (gameObjects.length === 0) throw new Error(`${targetPath} holds no GameObject`);
  let go: UnityDoc | undefined;
  if (opts.objectName) {
    go = gameObjects.find((d) => field(d, "m_Name") === opts.objectName);
    if (!go) throw new Error(`no GameObject named "${opts.objectName}" in ${targetPath} (have: ${gameObjects.map((d) => field(d, "m_Name")).join(", ")})`);
  } else {
    // Default: the object that already has a SpriteRenderer, else the root.
    const withRenderer = docs.find((d) => d.classId === 212);
    const rendererGo = withRenderer ? refFileId(field(withRenderer, "m_GameObject")) : undefined;
    go = gameObjects.find((d) => d.fileId === rendererGo) ?? gameObjects[0]!;
  }
  const goName = field(go, "m_Name") ?? go.fileId;
  const renderer = docs.find((d) => d.classId === 212 && refFileId(field(d, "m_GameObject")) === go.fileId);
  let rendererFileId: string;
  let added = false;
  if (renderer) {
    rendererFileId = renderer.fileId;
    if (!/^  m_Sprite: .*$/m.test(renderer.text)) throw new Error(`SpriteRenderer &${renderer.fileId} has no m_Sprite line`);
    // A reference the Editor wrapped onto continuation lines is replaced whole.
    renderer.text = renderer.text.replace(/^  m_Sprite: .*(?:\r?\n {4}[^\r\n]*)*$/m, `  m_Sprite: ${spriteRef(spriteGuid)}`);
    renderer.text = renderer.text.replace(/^  m_WasSpriteAssigned: \d$/m, "  m_WasSpriteAssigned: 1");
  } else {
    if (opts.addRenderer === false) throw new Error(`GameObject "${goName}" has no SpriteRenderer and addRenderer is false`);
    const taken = new Set(docs.map((d) => d.fileId));
    rendererFileId = freshFileId(taken);
    if (!/^  m_Component:\r?\n/m.test(go.text)) throw new Error(`GameObject "${goName}" has no m_Component list`);
    // Register the component on the GameObject, after its existing components.
    const eol = go.text.includes("\r\n") ? "\r\n" : "\n";
    go.text = go.text.replace(/^(  m_Component:\r?\n(?:  - component: \{fileID: -?\d+\}\r?\n)*)/m, `$1  - component: {fileID: ${rendererFileId}}${eol}`);
    docs.push({ classId: 212, fileId: rendererFileId, stripped: false, text: spriteRendererDoc(rendererFileId, go.fileId, spriteGuid) });
    added = true;
  }
  writeAtomic(targetPath, joinUnityDocs(preamble, docs));
  // Verify by re-reading — the delivery measurement reads the same bytes.
  const check = splitUnityDocs(readFileSync(targetPath, "utf8"));
  const bound = check.docs.find((d) => d.classId === 212 && d.fileId === rendererFileId);
  if (!bound || !bound.text.includes(`guid: ${spriteGuid}`)) {
    writeAtomic(targetPath, original);
    throw new Error("verification failed after write — the file was restored");
  }
  return { gameObject: goName, rendererFileId, added, importerFixed: false };
}

// ─── PrefabInstance ───────────────────────────────────────────────────────

/** The prefab's root GameObject and its Transform (the Transform whose m_Father is 0). */
export function prefabRoot(prefabText: string): { gameObjectId: string; transformId: string; transformClassId: number; name: string } {
  const { docs } = splitUnityDocs(prefabText);
  const rootTransform = docs.find((d) => (d.classId === 4 || d.classId === 224) && !d.stripped && /^  m_Father: \{fileID: 0\}\r?$/m.test(d.text));
  if (!rootTransform) throw new Error("prefab has no root Transform (m_Father: {fileID: 0}) — a prefab VARIANT inherits its root and is not supported here");
  const gameObjectId = refFileId(field(rootTransform, "m_GameObject"));
  const go = docs.find((d) => d.classId === 1 && d.fileId === gameObjectId);
  if (!gameObjectId || !go) throw new Error("prefab root Transform points at no GameObject");
  return { gameObjectId, transformId: rootTransform.fileId, transformClassId: rootTransform.classId, name: field(go, "m_Name") ?? "Prefab" };
}

export interface PlacePrefabResult {
  readonly prefabInstanceId: string;
  readonly strippedTransformId: string;
  readonly name: string;
  readonly rootRegistered: boolean;
}

/** Place a prefab as a root object of the scene, Unity 6 shape (PrefabInstance + stripped Transform + SceneRoots). */
export function placePrefab(
  scenePath: string,
  prefabGuid: string,
  root: { gameObjectId: string; transformId: string; transformClassId?: number; name: string },
  opts: { name?: string; position?: { x: number; y: number; z: number } } = {},
): PlacePrefabResult {
  const original = readFileSync(scenePath, "utf8");
  const { preamble, docs } = splitUnityDocs(original);
  const taken = new Set(docs.map((d) => d.fileId));
  const piId = freshFileId(taken);
  taken.add(piId);
  const stId = freshFileId(taken);
  const name = opts.name ?? root.name;
  const p = opts.position ?? { x: 0, y: 0, z: 0 };
  const mod = (target: string, path: string, value: string | number): string =>
    `    - target: {fileID: ${target}, guid: ${prefabGuid}, type: 3}\n      propertyPath: ${path}\n      value: ${value}\n      objectReference: {fileID: 0}\n`;
  const instance =
    `--- !u!1001 &${piId}\nPrefabInstance:\n  m_ObjectHideFlags: 0\n  serializedVersion: 2\n  m_Modification:\n    serializedVersion: 3\n    m_TransformParent: {fileID: 0}\n    m_Modifications:\n` +
    mod(root.transformId, "m_LocalPosition.x", p.x) +
    mod(root.transformId, "m_LocalPosition.y", p.y) +
    mod(root.transformId, "m_LocalPosition.z", p.z) +
    mod(root.transformId, "m_LocalRotation.w", 1) +
    mod(root.transformId, "m_LocalRotation.x", 0) +
    mod(root.transformId, "m_LocalRotation.y", 0) +
    mod(root.transformId, "m_LocalRotation.z", 0) +
    mod(root.gameObjectId, "m_Name", yamlString(name)) +
    `    m_RemovedComponents: []\n    m_RemovedGameObjects: []\n    m_AddedGameObjects: []\n    m_AddedComponents: []\n  m_SourcePrefab: {fileID: 100100000, guid: ${prefabGuid}, type: 3}\n`;
  // The proxy carries the ROOT'S class: a RectTransform root (224) gets a
  // stripped RectTransform, not a Transform (Codex review, 2026-09-07).
  const tClass = root.transformClassId === 224 ? 224 : 4;
  const tName = tClass === 224 ? "RectTransform" : "Transform";
  const stripped =
    `--- !u!${tClass} &${stId} stripped\n${tName}:\n  m_CorrespondingSourceObject: {fileID: ${root.transformId}, guid: ${prefabGuid}, type: 3}\n  m_PrefabInstance: {fileID: ${piId}}\n  m_PrefabAsset: {fileID: 0}\n`;
  const sceneRoots = docs.find((d) => d.classId === 1660057539);
  let rootRegistered = false;
  if (sceneRoots) {
    const eol = sceneRoots.text.includes("\r\n") ? "\r\n" : "\n";
    // An empty scene writes `m_Roots: []` inline; a filled one a block list.
    sceneRoots.text = sceneRoots.text.replace(/^  m_Roots: \[\]\r?$/m, "  m_Roots:");
    sceneRoots.text = sceneRoots.text.replace(/^(  m_Roots:\r?\n(?:  - \{fileID: -?\d+\}\r?\n)*)/m, `$1  - {fileID: ${stId}}${eol}`);
    if (!sceneRoots.text.endsWith("\n")) sceneRoots.text += eol;
    rootRegistered = sceneRoots.text.includes(`{fileID: ${stId}}`);
    if (!rootRegistered) throw new Error("the scene's SceneRoots block was not in a shape this tool can extend — nothing written");
    // Keep SceneRoots last, as the Editor writes it.
    const idx = docs.indexOf(sceneRoots);
    docs.splice(idx, 1);
    docs.push({ classId: 1001, fileId: piId, stripped: false, text: instance }, { classId: tClass, fileId: stId, stripped: true, text: stripped }, sceneRoots);
  } else {
    docs.push({ classId: 1001, fileId: piId, stripped: false, text: instance }, { classId: tClass, fileId: stId, stripped: true, text: stripped });
  }
  writeAtomic(scenePath, joinUnityDocs(preamble, docs));
  const check = splitUnityDocs(readFileSync(scenePath, "utf8"));
  const pi = check.docs.find((d) => d.classId === 1001 && d.fileId === piId);
  if (!pi || !pi.text.includes(`m_SourcePrefab: {fileID: 100100000, guid: ${prefabGuid}, type: 3}`)) {
    writeAtomic(scenePath, original);
    throw new Error("verification failed after write — the scene was restored");
  }
  return { prefabInstanceId: piId, strippedTransformId: stId, name, rootRegistered };
}

// ─── Tools ────────────────────────────────────────────────────────────────

async function checked(context: ToolContext, rel: string): Promise<{ ok: true; full: string } | { ok: false; error: string }> {
  const r = await validatePath(context.projectPath, rel, { allowMissingParents: false });
  return r.valid ? { ok: true, full: r.fullPath } : { ok: false, error: r.error ?? "path validation failed" };
}

export class BindSpriteTool implements ITool {
  readonly name = "unity_bind_sprite";
  readonly description =
    "Point a GameObject's SpriteRenderer at a sprite texture — in a .prefab or a .unity scene — editing the " +
    "serialized file directly (no Editor, no bridge) in Unity's own shape, adding a SpriteRenderer when the " +
    "object has none, fixing the texture's importer to Sprite when needed, and verifying by re-reading what it " +
    "wrote. Use this to bind generated or imported art to the prefab/object the GDD element uses; then " +
    "unity_place_prefab (or a scene that already holds the object) makes it render.";
  readonly inputSchema = {
    type: "object",
    properties: {
      target: { type: "string", description: "Project-relative .prefab or .unity path holding the GameObject." },
      sprite: { type: "string", description: "Project-relative texture path (PNG/JPG) that has a .meta." },
      objectName: { type: "string", description: "m_Name of the GameObject to bind. Default: the object that already has a SpriteRenderer, else the first GameObject." },
      addRenderer: { type: "boolean", description: "Add a SpriteRenderer when the object has none (default true)." },
    },
    required: ["target", "sprite"],
  };

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    if (context.readOnly) return { content: "Error: binding is disabled in read-only mode", isError: true };
    const targetRel = String(input["target"] ?? "").replace(/\\/g, "/");
    const spriteRel = String(input["sprite"] ?? "").replace(/\\/g, "/");
    if (!/\.(prefab|unity)$/i.test(targetRel)) return { content: "Error: target must be a .prefab or .unity file", isError: true };
    if (!/\.(png|jpg|jpeg|psd|tga)$/i.test(spriteRel)) return { content: "Error: sprite must be a texture file (png/jpg/psd/tga)", isError: true };
    const target = await checked(context, targetRel);
    if (!target.ok) return { content: `Error: ${target.error}`, isError: true };
    const sprite = await checked(context, spriteRel);
    if (!sprite.ok) return { content: `Error: ${sprite.error}`, isError: true };
    if (!existsSync(target.full)) return { content: `Error: ${targetRel} does not exist`, isError: true };
    if (!existsSync(sprite.full)) return { content: `Error: ${spriteRel} does not exist`, isError: true };
    const metaPath = `${sprite.full}.meta`;
    const guid = metaGuid(metaPath);
    if (!guid) {
      return { content: `Error: ${spriteRel} has no .meta with a guid — Unity has not imported it. Write it through unity_generate_sprite or unity_import_asset_package, which produce the .meta.`, isError: true };
    }
    try {
      const importerFixed = ensureSpriteImporter(metaPath);
      const r = bindSprite(target.full, guid, {
        objectName: typeof input["objectName"] === "string" ? input["objectName"] : undefined,
        addRenderer: input["addRenderer"] !== false,
      });
      return {
        content:
          `Bound ${spriteRel} (guid ${guid.slice(0, 8)}…) to "${r.gameObject}" in ${targetRel}: SpriteRenderer &${r.rendererFileId}` +
          `${r.added ? " ADDED and registered on the GameObject" : " m_Sprite replaced"}${importerFixed ? "; the texture's importer was switched to Sprite" : ""}. ` +
          "Verified by re-reading the file. " +
          (/\.prefab$/i.test(targetRel)
            ? "A prefab renders only where a scene places it — unity_place_prefab, or a config the bootstrapper instantiates."
            : "The scene now holds a renderer bound to project art."),
      };
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
}

export class PlacePrefabTool implements ITool {
  readonly name = "unity_place_prefab";
  readonly description =
    "Place a prefab instance as a root object of a .unity scene by editing the scene file directly (no Editor, " +
    "no bridge): a PrefabInstance in Unity 6's own shape with position/name overrides, its stripped Transform, " +
    "and a SceneRoots entry, verified by re-reading. This is what turns 'the shipped scenes place 0 renderers' " +
    "into a scene that draws the project's own prefabs — the delivery measurement counts exactly these.";
  readonly inputSchema = {
    type: "object",
    properties: {
      scene: { type: "string", description: "Project-relative .unity path (an enabled scene in Build Settings, normally the entry scene)." },
      prefab: { type: "string", description: "Project-relative .prefab path to instantiate." },
      name: { type: "string", description: "Instance name (default: the prefab's root object name)." },
      position: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, description: "World position (default 0,0,0)." },
    },
    required: ["scene", "prefab"],
  };

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    if (context.readOnly) return { content: "Error: placement is disabled in read-only mode", isError: true };
    const sceneRel = String(input["scene"] ?? "").replace(/\\/g, "/");
    const prefabRel = String(input["prefab"] ?? "").replace(/\\/g, "/");
    if (!/\.unity$/i.test(sceneRel)) return { content: "Error: scene must be a .unity file", isError: true };
    if (!/\.prefab$/i.test(prefabRel)) return { content: "Error: prefab must be a .prefab file", isError: true };
    const scene = await checked(context, sceneRel);
    if (!scene.ok) return { content: `Error: ${scene.error}`, isError: true };
    const prefab = await checked(context, prefabRel);
    if (!prefab.ok) return { content: `Error: ${prefab.error}`, isError: true };
    if (!existsSync(scene.full)) return { content: `Error: ${sceneRel} does not exist`, isError: true };
    if (!existsSync(prefab.full)) return { content: `Error: ${prefabRel} does not exist`, isError: true };
    const guid = metaGuid(`${prefab.full}.meta`);
    if (!guid) return { content: `Error: ${prefabRel} has no .meta with a guid`, isError: true };
    try {
      const root = prefabRoot(readFileSync(prefab.full, "utf8"));
      const pos = input["position"] as { x?: number; y?: number; z?: number } | undefined;
      const r = placePrefab(scene.full, guid, root, {
        name: typeof input["name"] === "string" ? input["name"] : undefined,
        position: pos ? { x: Number(pos.x ?? 0), y: Number(pos.y ?? 0), z: Number(pos.z ?? 0) } : undefined,
      });
      return {
        content:
          `Placed ${prefabRel} in ${sceneRel} as "${r.name}": PrefabInstance &${r.prefabInstanceId} (source guid ${guid.slice(0, 8)}…), ` +
          `stripped Transform &${r.strippedTransformId}${r.rootRegistered ? ", registered in SceneRoots" : " (scene has no SceneRoots block; older Unity orders roots itself)"}. ` +
          "Verified by re-reading the scene. Run unity_playmode_verify with capture to see it drawn.",
      };
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
}
