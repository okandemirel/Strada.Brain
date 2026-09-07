/**
 * Built-as-specified — what the SHIPPED scenes actually render.
 *
 * Audited 2026-09-03. A campaign delivered "game build complete" (7/7 sprints
 * green, 11351 captured frames) for a project whose entry scene
 * Assets/Scenes/ProductionMain.unity holds ZERO MeshFilter/MeshRenderer
 * components, whose five runtime scripts build the visible world with
 * GameObject.CreatePrimitive, and which already carried 100 prefabs, 198 pngs
 * and 62 fbx/obj models that nothing binds. What the user opened was a grid of
 * flat coloured squares with four spheres under it. Nothing in the pipeline
 * ever asked what the delivered scenes contain.
 *
 * This module MEASURES that, from the files Unity itself reads:
 *   - the enabled scenes in ProjectSettings/EditorBuildSettings.asset,
 *   - every renderer component in those scenes AND in the prefabs they
 *     instantiate (a PrefabInstance's m_SourcePrefab guid is followed into the
 *     .prefab file — a prefab's contents are the scene's contents),
 *   - for each renderer, whether its material/mesh/sprite is a PROJECT asset
 *     (a real guid) or one of Unity's built-in ids (Default-Material 10303,
 *     the built-in Cube 10202 / Sphere 10207 meshes, guid 0000…f000…),
 *   - runtime scripts that construct geometry via CreatePrimitive/PrimitiveType
 *     outside Assets/Tests, Assets/Editor and InitTestScene*,
 *   - which of the project's prefabs, imported models and sprite textures no
 *     enabled scene reaches, transitively, by guid.
 *
 * It is deliberately NOT a text heuristic over names or prose: every number
 * here is a component or a guid counted in a file on disk. Three gates were
 * refused on review the day before this one was written because a keyword scan
 * satisfied by the same slop it was meant to catch is not a measurement.
 *
 * Refusal is reserved for the strong, unambiguous case (see
 * `structuralRefusal`); everything softer is disclosure, because a stylised
 * look can legitimately be built in ways this file cannot see.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { basename, join, relative, sep } from "node:path";
import type { SceneWiringIo } from "./scene-wiring.js";

// ─── I/O ───────────────────────────────────────────────────────────────────

/** Same injectable shape the sibling scene checks use, so tests need no disk. */
export type BuiltAsSpecifiedIo = SceneWiringIo;

/**
 * How many matching files one walk may return. Hitting it is REPORTED, never
 * swallowed (audited 2026-09-03): a truncated walk that reads like a complete
 * one would call bound art unbound and empty scenes fully measured.
 */
export const ASSET_WALK_BUDGET = 20_000;

/** How many directory entries one walk may visit before it stops — reported through `lastWalkVisitCapHit`. */
export const WALK_VISIT_CAP = 120_000;
/** Set by the last walk() when it stopped on the visit cap; the caller discloses it (review 2026-09-07: it was silent). */
let lastWalkVisitCapHit = false;

function walk(dir: string, match?: (file: string) => boolean, budget = ASSET_WALK_BUDGET): string[] {
  const out: string[] = [];
  const stack = [dir];
  let visited = 0;
  lastWalkVisitCapHit = false;
  while (stack.length > 0 && out.length < budget && visited < WALK_VISIT_CAP) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited++;
      const full = join(current, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) stack.push(full);
      else if (!match || match(full)) out.push(full);
    }
  }
  if (stack.length > 0 && visited >= WALK_VISIT_CAP) lastWalkVisitCapHit = true;
  return out;
}

const defaultIo: BuiltAsSpecifiedIo = {
  listFiles: (dir, match) => walk(dir, match),
  readFile: (p) => readFileSync(p, "utf-8"),
  exists: (p) => existsSync(p),
};

// ─── Unity constants ───────────────────────────────────────────────────────

/**
 * Unity's own asset libraries. Anything referenced through one of these guids
 * shipped with the engine — it is not art this project made or imported.
 * f000… = "unity default resources", e000… = "unity_builtin_extra",
 * d000… = "unity editor resources".
 */
export const UNITY_BUILT_IN_GUIDS: ReadonlySet<string> = new Set([
  "0000000000000000f000000000000000",
  "0000000000000000e000000000000000",
  "0000000000000000d000000000000000",
]);

/**
 * The handful of built-in fileIDs worth naming in a refusal, so the message
 * says "the built-in Cube mesh" rather than "fileID 10202". Only ids that are
 * certain are listed; anything else is reported by its number.
 */
const NAMED_BUILT_IN_IDS: ReadonlyMap<number, string> = new Map([
  [10303, "Default-Material"],
  [10202, "built-in Cube mesh"],
  [10207, "built-in Sphere mesh"],
]);

/** Component classes that put pixels on screen. */
const RENDERER_CLASSES: ReadonlySet<string> = new Set([
  "MeshRenderer",
  "SkinnedMeshRenderer",
  "SpriteRenderer",
  "ParticleSystemRenderer",
  "LineRenderer",
  "TrailRenderer",
  "TilemapRenderer",
  "SpriteShapeRenderer",
  "CanvasRenderer",
  "VideoPlayer",
  "Terrain",
]);

/**
 * Renderers that draw UI or video, not the game world. They are counted and
 * reported, but the "renders NOTHING" refusal looks past them: review
 * 2026-09-07 — one HUD Text (a CanvasRenderer) on the audited PixelFlow
 * shape lifted the refusal while the world was still CreatePrimitive cubes.
 */
const NON_WORLD_RENDERER_CLASSES: ReadonlySet<string> = new Set(["CanvasRenderer", "VideoPlayer"]);

/** Renderer classes that draw actual 3D geometry (item 2's disclosure). */
const MESH_RENDERER_CLASSES: ReadonlySet<string> = new Set([
  "MeshRenderer",
  "SkinnedMeshRenderer",
]);

const MODEL_EXT_RE = /\.(?:fbx|obj|blend|dae|gltf|glb|3ds|max|ma|mb)$/iu;
const SPRITE_EXT_RE = /\.(?:png|jpg|jpeg|psd|tga|exr|tif|tiff)$/iu;
const AUDIO_EXT_RE = /\.(?:wav|ogg|mp3|aif|aiff|flac)$/iu;
/** A clip shorter than this is a blip, whatever it is named. */
const SHORT_AUDIO_SECONDS = 0.5;
const FOLLOWABLE_EXT_RE = /\.(?:prefab|asset|unity|mat|controller|overrideController|playable|spriteatlas|anim)$/iu;

// ─── Result shapes ─────────────────────────────────────────────────────────

/** How one serialized reference resolves. */
export type ReferenceSource = "project" | "built-in" | "none";

export interface SceneStructure {
  /** Project-relative path exactly as EditorBuildSettings lists it. */
  readonly scene: string;
  /** The scene is listed in the build but the file is not on disk. */
  readonly missing: boolean;
  /**
   * Unity's own test-runner scene (InitTestScene<guid>) or a scene under
   * Assets/Tests / Assets/Editor. Measured but never judged as shipped work.
   */
  readonly scaffolding: boolean;
  /** Renderer components in the scene file itself. */
  readonly renderersInScene: number;
  /** Of the scene's own and placed renderers, those that draw the WORLD (not UI canvas / video). */
  readonly worldRenderersShipped: number;
  /**
   * Renderer components inside the prefabs the scene PLACES (a PrefabInstance
   * whose m_SourcePrefab guid resolves to a .prefab, recursively). A placed
   * prefab's contents are the scene's contents.
   */
  readonly renderersInPlacedPrefabs: number;
  /**
   * Renderer components in prefabs the scene only REFERENCES — reached by guid
   * through a config asset or a serialized script field, never placed. Nothing
   * here is on screen unless code instantiates it at runtime, which a file scan
   * cannot verify, so this is reported and never counted as what ships.
   */
  readonly renderersInReferencedPrefabs: number;
  /** Mesh-drawing renderers (MeshRenderer/SkinnedMeshRenderer), placed only. */
  readonly meshRenderers: number;
  /** SpriteRenderers, placed only. */
  readonly spriteRenderers: number;
  /** Material/mesh/sprite references pointing at an asset of this project. */
  readonly projectRefs: number;
  /** Material/mesh/sprite references pointing at a Unity built-in id. */
  readonly builtInRefs: number;
  /** Distinct built-in ids seen, named where the name is certain. */
  readonly builtInIds: readonly string[];
  /** Imported model files (fbx/obj/…) a PLACED renderer or MeshFilter binds. */
  readonly modelsBound: readonly string[];
  /** Prefabs instantiated whose guid resolves to no file on disk. */
  readonly unresolvedPrefabGuids: readonly string[];
  readonly camerasOrthographic: number;
  readonly camerasPerspective: number;
  /**
   * What the scene FILE itself holds, placed prefabs excluded: GameObject and
   * PrefabInstance documents, and the MonoBehaviour classes on them.
   *
   * Audited 2026-09-04: the refusal could say "the shipped scenes render
   * NOTHING" and the sprint still had nowhere to start, because the number it
   * was given was a zero. PixelFlow's one enabled scene held a camera and a
   * `GameBootstrapper` whose config listed no modules — two GameObjects, no
   * prefab instance — and naming that is the difference between "something is
   * wrong" and "this is the scene you have to fill".
   */
  readonly gameObjects: number;
  readonly prefabInstances: number;
  /** Distinct MonoBehaviour class names on the scene's own objects, sorted. */
  readonly scripts: readonly string[];
}

export interface ArtInventory {
  readonly prefabs: number;
  readonly models: number;
  readonly sprites: number;
  /**
   * Sprite textures whose PNG compresses below PLACEHOLDER_BYTES_PER_PIXEL —
   * flat procedural shapes, not drawn art. Measured 2026-09-06 on the PixelFlow
   * lease: 409 of 428 sprites, median 281 bytes at 64×64, every one produced by
   * the procedural generator and every one counted as "a sprite texture" by
   * the line below. A project whose art is 95% solid squares had passed this
   * gate as art-complete.
   */
  readonly placeholderSprites: number;
  /**
   * Audio clips under Assets/, and what their bytes say. Measured 2026-09-07
   * on the PixelFlow project: 19 WAVs — six 90-second "music" loops and
   * thirteen 0.15-second SFX blips, four of them byte-identical to another —
   * counted nowhere, while the GDD scheduled a music base loop, area
   * variations and a complete SFX cue list.
   */
  readonly audio: number;
  /** Clips whose bytes equal another clip's — the same sound under two names. */
  readonly duplicateAudio: number;
  /** Clips shorter than SHORT_AUDIO_SECONDS (WAV only; other formats are unmeasured). */
  readonly shortAudio: number;
}

export interface BuiltAsSpecifiedReport {
  /** Whether the check could measure anything at all. */
  readonly measured: boolean;
  /** Every enabled scene in build order; index 0 is Unity's entry scene. */
  readonly scenes: readonly SceneStructure[];
  /** Scenes judged as shipped work (scaffolding excluded). */
  readonly shippedScenes: readonly SceneStructure[];
  /** Renderers actually placed in the shipped scenes (scene + placed prefabs). */
  readonly shippedRenderers: number;
  /** Of those, the ones that draw the world (UI canvas and video excluded). */
  readonly shippedWorldRenderers: number;
  /** Renderers in prefabs the shipped scenes only reference, never place. */
  readonly referencedOnlyRenderers: number;
  readonly shippedProjectRefs: number;
  readonly shippedBuiltInRefs: number;
  readonly shippedMeshRenderers: number;
  readonly shippedSpriteRenderers: number;
  readonly artInventory: ArtInventory;
  /** Project art no enabled scene reaches, transitively, by guid. */
  readonly unboundPrefabs: readonly string[];
  readonly unboundModels: readonly string[];
  readonly unboundSprites: readonly string[];
  /** Sprite textures measured as placeholder-grade (see ArtInventory). */
  readonly placeholderSpritePaths: readonly string[];
  /** Runtime scripts that build geometry with CreatePrimitive/PrimitiveType. */
  readonly primitiveScripts: readonly string[];
  /** CreatePrimitive( call sites across those scripts — one fade quad is not a world. */
  readonly primitiveCallSites: number;
  /**
   * Set ONLY on the strong, unambiguous case. Names the scene, the counts and
   * the unbound assets — a refusal that cannot be acted on is a wall.
   */
  readonly refusal?: string;
  /** Everything measured that is worth saying but never worth refusing over. */
  readonly disclosures: readonly string[];
  /** What could not be measured. A skipped check must not read like a pass. */
  readonly incomplete: readonly string[];
}

// ─── Unity YAML ────────────────────────────────────────────────────────────

interface UnityDocument {
  readonly className: string;
  readonly lines: readonly string[];
}

/**
 * Split a .unity/.prefab file into its component documents.
 *
 * Unity writes `--- !u!<classId> &<fileId>` and then the class name on its own
 * line. Reading the class name (not a regex over the whole file) is what makes
 * "how many renderers" a count of components rather than a count of word
 * occurrences.
 */
export function parseUnityDocuments(text: string): UnityDocument[] {
  const docs: UnityDocument[] = [];
  let className: string | undefined;
  let lines: string[] = [];
  let stripped = false;
  const flush = (): void => {
    // A `stripped` document is a prefab component the scene references, not
    // a component of its own — counting it doubled every placed renderer
    // (review 2026-09-07).
    if (className !== undefined && !stripped) docs.push({ className, lines });
    className = undefined;
    lines = [];
  };
  // CRLF files lost every keyed line to `(.*)$` (review 2026-09-07).
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("--- !u!")) {
      flush();
      className = "";
      stripped = /\sstripped\s*$/.test(line);
      continue;
    }
    if (className === "") {
      const name = /^([A-Za-z_][A-Za-z0-9_]*):\s*$/.exec(line)?.[1];
      className = name ?? "?";
      continue;
    }
    if (className !== undefined) lines.push(line);
  }
  flush();
  return docs;
}

interface UnityRef {
  readonly fileId: number;
  readonly guid?: string;
}

const REF_RE = /\{fileID:\s*(-?\d+)(?:,\s*guid:\s*([0-9a-fA-F]{32}))?/u;

function parseRef(value: string): UnityRef | undefined {
  const m = REF_RE.exec(value);
  if (!m) return undefined;
  return { fileId: Number(m[1]), guid: m[2]?.toLowerCase() };
}

export function classifyRef(ref: UnityRef): ReferenceSource {
  if (ref.fileId === 0 && !ref.guid) return "none";
  if (!ref.guid || UNITY_BUILT_IN_GUIDS.has(ref.guid)) return "built-in";
  if (/^0{32}$/.test(ref.guid)) return "built-in";
  return "project";
}

function describeBuiltIn(ref: UnityRef): string {
  return NAMED_BUILT_IN_IDS.get(ref.fileId) ?? `built-in fileID ${ref.fileId}`;
}

// ─── Per-file scan ─────────────────────────────────────────────────────────

interface Tally {
  renderers: number;
  /** Renderers that draw the world — everything but UI canvas and video. */
  worldRenderers: number;
  meshRenderers: number;
  spriteRenderers: number;
  projectRefs: number;
  builtInRefs: number;
  builtInIds: Set<string>;
  /** guids of project assets a renderer/MeshFilter actually binds. */
  refGuids: Set<string>;
  /** m_SourcePrefab guids — prefabs PLACED in this file. */
  prefabGuids: Set<string>;
  camerasOrthographic: number;
  camerasPerspective: number;
  /** GameObject documents in THIS file — the scene's own composition. */
  gameObjects: number;
  /** PrefabInstance documents in THIS file. */
  prefabInstances: number;
  /**
   * Distinct MonoBehaviour class names, read off `m_EditorClassIdentifier`
   * (Unity writes `Assembly::Namespace.Class`). A script whose identifier
   * Unity left blank contributes nothing rather than a guessed name.
   */
  scripts: Set<string>;
}

function newTally(): Tally {
  return {
    renderers: 0,
    worldRenderers: 0,
    meshRenderers: 0,
    spriteRenderers: 0,
    projectRefs: 0,
    builtInRefs: 0,
    builtInIds: new Set(),
    refGuids: new Set(),
    prefabGuids: new Set(),
    camerasOrthographic: 0,
    camerasPerspective: 0,
    gameObjects: 0,
    prefabInstances: 0,
    scripts: new Set(),
  };
}

/**
 * Count one scene/prefab file's own components.
 *
 * Material lists are read as lists (`m_Materials:` then `- {fileID: …}`) so an
 * empty list counts as zero references instead of silently inheriting the
 * previous key's classification.
 */
function scanUnityFile(text: string, tally: Tally): void {
  for (const doc of parseUnityDocuments(text)) {
    const isRenderer = RENDERER_CLASSES.has(doc.className);
    if (isRenderer) {
      tally.renderers++;
      if (!NON_WORLD_RENDERER_CLASSES.has(doc.className)) tally.worldRenderers++;
      if (MESH_RENDERER_CLASSES.has(doc.className)) tally.meshRenderers++;
      if (doc.className === "SpriteRenderer") tally.spriteRenderers++;
    }
    if (doc.className === "GameObject") tally.gameObjects++;
    if (doc.className === "PrefabInstance") tally.prefabInstances++;
    const wantsRefs = isRenderer || doc.className === "MeshFilter";
    // Project bindings live off the renderer document too (review 2026-09-07):
    // a Tilemap's tile sprites, a UI Image's sprite, a Terrain's data, and a
    // PrefabInstance's per-instance overrides of m_Sprite / m_Mesh /
    // m_Materials. Read only from the renderer, a legitimate tilemap level or
    // an instance-configured sprite prefab measured as "all built-in".
    let inTileList = false;
    let overridePath: string | undefined;
    let inMaterialList = false;
    for (const line of doc.lines) {
      if (doc.className === "Tilemap") {
        // Only the document's own keys (two-space indent) open or close a
        // list; a list item's nested keys (m_Data, m_RefCount) do not.
        const keyedTile = /^  ([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
        if (keyedTile) inTileList = keyedTile[1] === "m_TileSpriteArray" || keyedTile[1] === "m_TileAssetArray";
        if (inTileList) {
          const ref = parseRef(line);
          if (ref?.guid) recordRef(ref, tally);
        }
        continue;
      }
      if (doc.className === "PrefabInstance") {
        const pathMatch = /^\s*-?\s*propertyPath:\s*(\S+)\s*$/.exec(line);
        if (pathMatch) {
          overridePath = pathMatch[1];
        } else if (overridePath !== undefined && /^\s*objectReference:/.test(line)) {
          if (/^(?:m_Sprite|m_Mesh|m_Materials\.Array\.data\[\d+\])$/.test(overridePath)) {
            const ref = parseRef(line);
            if (ref) recordRef(ref, tally);
          }
          overridePath = undefined;
        }
      }
      const keyed = /^\s*([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
      if (keyed) {
        const key = keyed[1]!;
        const rest = keyed[2]!;
        inMaterialList = wantsRefs && key === "m_Materials" && rest.trim() === "";
        if (doc.className === "Camera" && key === "orthographic") {
          if (rest.trim() === "1") tally.camerasOrthographic++;
          else if (rest.trim() === "0") tally.camerasPerspective++;
        }
        if (doc.className === "MonoBehaviour" && key === "m_EditorClassIdentifier") {
          // "Assembly::Namespace.Class" → "Class". The identifier is empty for
          // a script Unity has not resolved; an empty name is dropped rather
          // than reported as an unnamed component.
          const short = rest.trim().split("::").pop()?.split(".").pop() ?? "";
          if (short.length > 0) tally.scripts.add(short);
        }
        if (doc.className === "PrefabInstance" && key === "m_SourcePrefab") {
          const ref = parseRef(rest);
          if (ref?.guid && classifyRef(ref) === "project") tally.prefabGuids.add(ref.guid);
        }
        if (wantsRefs && (key === "m_Sprite" || key === "m_Mesh")) {
          const ref = parseRef(rest);
          if (ref) recordRef(ref, tally);
        }
        if (doc.className === "Terrain" && key === "m_TerrainData") {
          const ref = parseRef(rest);
          if (ref) recordRef(ref, tally);
        }
        if (doc.className === "MonoBehaviour" && key === "m_Sprite") {
          const ref = parseRef(rest); // UI Image and friends
          if (ref?.guid) recordRef(ref, tally);
        }
        continue;
      }
      if (inMaterialList && /^\s*-\s*\{fileID:/.test(line)) {
        const ref = parseRef(line);
        if (ref) recordRef(ref, tally);
        continue;
      }
      // A non-keyed, non-list line ends the material list block.
      if (line.trim() !== "") inMaterialList = false;
    }
  }
}

function mergeTally(into: Tally, from: Tally): void {
  into.renderers += from.renderers;
  into.worldRenderers += from.worldRenderers;
  into.meshRenderers += from.meshRenderers;
  into.spriteRenderers += from.spriteRenderers;
  into.projectRefs += from.projectRefs;
  into.builtInRefs += from.builtInRefs;
  for (const id of from.builtInIds) into.builtInIds.add(id);
  for (const g of from.refGuids) into.refGuids.add(g);
  into.camerasOrthographic += from.camerasOrthographic;
  into.camerasPerspective += from.camerasPerspective;
}

function recordRef(ref: UnityRef, tally: Tally): void {
  const source = classifyRef(ref);
  if (source === "project") {
    tally.projectRefs++;
    if (ref.guid) tally.refGuids.add(ref.guid);
  } else if (source === "built-in") {
    tally.builtInRefs++;
    tally.builtInIds.add(describeBuiltIn(ref));
  }
}

// ─── Build settings ────────────────────────────────────────────────────────

/** Enabled scene paths in build order. Index 0 is the entry scene. */
export function readEnabledBuildScenes(projectRoot: string, io: BuiltAsSpecifiedIo): string[] {
  const path = join(projectRoot, "ProjectSettings", "EditorBuildSettings.asset");
  if (!io.exists(path)) return [];
  let text: string;
  try {
    text = io.readFile(path);
  } catch {
    return [];
  }
  const scenes: string[] = [];
  let enabled = false;
  for (const line of text.split(/\r?\n/)) {
    const enabledMatch = /^\s*-\s*enabled:\s*(\d)\s*$/.exec(line);
    if (enabledMatch) {
      enabled = enabledMatch[1] === "1";
      continue;
    }
    const pathMatch = /^\s*path:\s*(\S.*?)\s*$/.exec(line);
    if (pathMatch && enabled) scenes.push(pathMatch[1]!);
  }
  return scenes;
}

/**
 * Scenes that exist to verify something, not to be played.
 *
 * Only mechanical markers: Unity's own generated InitTestScene<guid>, and
 * anything under a Tests/ or Editor/ folder. Deliberately NOT a name list —
 * excusing a scene because it is called "Assembled…" would let the next
 * delivery pass by renaming its empty scene.
 */
export function isScaffoldingScene(scenePath: string): boolean {
  const norm = scenePath.replace(/\\/g, "/");
  if (/(^|\/)InitTestScene[^/]*\.unity$/i.test(norm)) return true;
  return /(^|\/)(Tests?|Editor)\//i.test(norm);
}

// ─── Primitive geometry in runtime code ────────────────────────────────────

/** Comments stripped, so a commented-out mention is not evidence of anything. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/\/\/[^\n]*/gu, " ");
}

const PRIMITIVE_RE = /\bGameObject\s*\.\s*CreatePrimitive\b|\bPrimitiveType\s*\.\s*[A-Z]/u;

function isRuntimeScript(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/");
  if (/(^|\/)(Tests?|Editor)\//i.test(norm)) return false;
  return !/(^|\/)InitTestScene/i.test(norm);
}

// ─── The measurement ───────────────────────────────────────────────────────

export function assessBuiltAsSpecified(
  projectRoot: string,
  io: BuiltAsSpecifiedIo = defaultIo,
  /** Tests shrink the walk budget to exercise the truncation disclosure. */
  opts: { walkBudget?: number } = {},
): BuiltAsSpecifiedReport {
  const walkBudget = opts.walkBudget ?? ASSET_WALK_BUDGET;
  // The budget belongs to the walk, so a shrunken one really truncates rather
  // than only changing the arithmetic the disclosure is derived from.
  if (io === defaultIo) io = { ...defaultIo, listFiles: (dir, match) => walk(dir, match, walkBudget) };
  const assetsRoot = join(projectRoot, "Assets");
  const empty = {
    scenes: [] as SceneStructure[],
    shippedScenes: [] as SceneStructure[],
    shippedRenderers: 0,
    shippedWorldRenderers: 0,
    referencedOnlyRenderers: 0,
    shippedProjectRefs: 0,
    shippedBuiltInRefs: 0,
    shippedMeshRenderers: 0,
    shippedSpriteRenderers: 0,
    artInventory: { prefabs: 0, models: 0, sprites: 0, placeholderSprites: 0, audio: 0, duplicateAudio: 0, shortAudio: 0 },
    unboundPrefabs: [] as string[],
    unboundModels: [] as string[],
    unboundSprites: [] as string[],
    placeholderSpritePaths: [] as string[],
    primitiveScripts: [] as string[],
    primitiveCallSites: 0,
    disclosures: [] as string[],
  };
  if (!io.exists(assetsRoot)) {
    return {
      ...empty,
      measured: false,
      incomplete: ["no Assets/ directory — the shipped scenes could not be measured"],
    };
  }

  const incomplete: string[] = [];
  const disclosures: string[] = [];

  const enabled = readEnabledBuildScenes(projectRoot, io);
  if (enabled.length === 0) {
    incomplete.push(
      "ProjectSettings/EditorBuildSettings.asset lists no ENABLED scene — there is no shipped scene to measure",
    );
  }

  // One walk, reused by every rule below.
  const files = io
    .listFiles(assetsRoot, (f) => /\.(?:meta|prefab|asset|unity|cs|mat|controller|overrideController|playable|spriteatlas|anim)$/iu.test(f))
    .map((f) => relative(projectRoot, f).split(sep).join("/"));
  const fileSet = new Set(files);
  if (lastWalkVisitCapHit) {
    incomplete.push(
      `the Assets/ scene-and-script walk stopped after visiting ${WALK_VISIT_CAP} entries — directories beyond that were not read, ` +
        "so art may be reported as unbound when it is not",
    );
  }
  if (files.length >= walkBudget) {
    incomplete.push(
      `the Assets/ scene-and-script walk returned its maximum of ${walkBudget} files — guids, prefabs and ` +
        "scripts beyond that were not read, so art may be reported as unbound when it is not",
    );
  }

  // Assets a scene reaches WITHOUT a guid (review 2026-09-07): anything under
  // a Resources/ folder is loadable by name, and Addressables are keyed by
  // string in AddressableAssetsData. A Resources.Load game refused as
  // "render NOTHING … prefab unbound" was legitimately built.
  const implicitlyReachable: string[] = [];

  // guid → project-relative path, from the .meta sidecars Unity writes.
  const guidToPath = new Map<string, string>();
  for (const rel of files) {
    if (!rel.endsWith(".meta")) continue;
    let guid: string | undefined;
    try {
      guid = /^guid:\s*([0-9a-f]{32})\s*$/m.exec(io.readFile(join(projectRoot, rel)))?.[1];
    } catch {
      continue;
    }
    if (guid) guidToPath.set(guid, rel.slice(0, -".meta".length));
  }
  for (const [guid, path] of guidToPath) {
    if (/(^|\/)Resources\//.test(path)) implicitlyReachable.push(guid);
  }
  for (const rel of files) {
    if (!/^Assets\/AddressableAssetsData\/.*\.asset$/i.test(rel)) continue;
    try {
      for (const g of collectGuids(io.readFile(join(projectRoot, rel)))) implicitlyReachable.push(g);
    } catch {
      incomplete.push(`${rel} (Addressables data) could not be read`);
    }
  }

  // ── Per-scene structure, prefabs followed by guid ──────────────────────
  const boundGuids = new Set<string>();
  const scenes: SceneStructure[] = [];
  for (const scenePath of enabled) {
    const abs = join(projectRoot, scenePath);
    const scaffolding = isScaffoldingScene(scenePath);
    if (!io.exists(abs)) {
      scenes.push({
        scene: scenePath,
        missing: true,
        scaffolding,
        renderersInScene: 0,
        renderersInPlacedPrefabs: 0,
        worldRenderersShipped: 0,
        renderersInReferencedPrefabs: 0,
        meshRenderers: 0,
        spriteRenderers: 0,
        projectRefs: 0,
        builtInRefs: 0,
        builtInIds: [],
        modelsBound: [],
        unresolvedPrefabGuids: [],
        camerasOrthographic: 0,
        camerasPerspective: 0,
        gameObjects: 0,
        prefabInstances: 0,
        scripts: [],
      });
      incomplete.push(`${scenePath} is enabled in Build Settings but the file is not on disk`);
      continue;
    }

    const own = newTally();
    let sceneText = "";
    try {
      sceneText = io.readFile(abs);
    } catch {
      incomplete.push(`${scenePath} could not be read — its contents are unmeasured`);
      continue;
    }
    if (sceneText.slice(0, 4096).includes("\0")) {
      // Force Binary / Mixed serialization: nothing here is text to scan.
      incomplete.push(`${scenePath} is binary-serialized, not text — its contents are unmeasured`);
      continue;
    }
    scanUnityFile(sceneText, own);

    // PLACED: prefab instances the scene actually contains, followed
    // recursively through nested instances. This is what the scene renders.
    const placed = newTally();
    const placedFiles = new Set<string>();
    const unresolved = new Set<string>();
    const placedQueue = [...own.prefabGuids];
    const seenPrefabGuids = new Set(placedQueue);
    while (placedQueue.length > 0 && placedFiles.size < 2_000) {
      const guid = placedQueue.shift()!;
      const target = guidToPath.get(guid);
      // Dragging an FBX into the Hierarchy writes a PrefabInstance whose
      // source is the model itself (review 2026-09-07): that is a placed,
      // project-bound mesh, not an unresolved prefab.
      if (target && MODEL_EXT_RE.test(target)) {
        placed.renderers++;
        placed.worldRenderers++;
        placed.meshRenderers++;
        placed.projectRefs++;
        placed.refGuids.add(guid);
        continue;
      }
      if (!target || !target.endsWith(".prefab") || !fileSet.has(target)) {
        unresolved.add(guid);
        continue;
      }
      placedFiles.add(target);
      let text: string;
      try {
        text = io.readFile(join(projectRoot, target));
      } catch {
        incomplete.push(`${target} (placed in ${scenePath}) could not be read`);
        continue;
      }
      const nested = newTally();
      scanUnityFile(text, nested);
      mergeTally(placed, nested);
      for (const g of nested.prefabGuids) {
        if (seenPrefabGuids.has(g)) continue;
        seenPrefabGuids.add(g);
        placedQueue.push(g);
      }
    }

    // REACHABLE: everything the scene mentions by guid, transitively through
    // prefabs and config assets. Used ONLY to decide what art nothing binds —
    // a scene holding a PresentationPrefabConfig that points at a prefab HAS
    // referenced that prefab, and calling it unbound would be a false
    // accusation. Its renderers are reported separately, never as shipped.
    const reach = new Set<string>();
    const queue: string[] = [];
    for (const g of [...collectGuids(sceneText), ...implicitlyReachable]) {
      if (reach.has(g)) continue;
      reach.add(g);
      queue.push(g);
    }
    const referencedOnly = newTally();
    let expanded = 0;
    while (queue.length > 0 && expanded < 4_000) {
      const guid = queue.shift()!;
      const target = guidToPath.get(guid);
      if (!target) continue;
      if (!FOLLOWABLE_EXT_RE.test(target) || !fileSet.has(target)) continue;
      expanded++;
      let text: string;
      try {
        text = io.readFile(join(projectRoot, target));
      } catch {
        incomplete.push(`${target} (reached from ${scenePath}) could not be read`);
        continue;
      }
      if (target.endsWith(".prefab") && !placedFiles.has(target)) {
        const t = newTally();
        scanUnityFile(text, t);
        mergeTally(referencedOnly, t);
      }
      for (const g of collectGuids(text)) {
        if (reach.has(g)) continue;
        reach.add(g);
        queue.push(g);
      }
    }
    if (queue.length > 0) {
      incomplete.push(
        `${scenePath}: the reference walk hit its 4000-file budget — ${queue.length} references were not followed, ` +
          "so art they reach may be reported as unbound when it is not",
      );
    }
    for (const g of reach) boundGuids.add(g);

    const boundModels = [...own.refGuids, ...placed.refGuids]
      .map((g) => guidToPath.get(g))
      .filter((p): p is string => p !== undefined && MODEL_EXT_RE.test(p));

    scenes.push({
      scene: scenePath,
      missing: false,
      scaffolding,
      renderersInScene: own.renderers,
      renderersInPlacedPrefabs: placed.renderers,
      worldRenderersShipped: own.worldRenderers + placed.worldRenderers,
      renderersInReferencedPrefabs: referencedOnly.renderers,
      meshRenderers: own.meshRenderers + placed.meshRenderers,
      spriteRenderers: own.spriteRenderers + placed.spriteRenderers,
      projectRefs: own.projectRefs + placed.projectRefs,
      builtInRefs: own.builtInRefs + placed.builtInRefs,
      builtInIds: [...new Set([...own.builtInIds, ...placed.builtInIds])].sort(),
      modelsBound: [...new Set(boundModels)].sort(),
      unresolvedPrefabGuids: [...unresolved].sort(),
      camerasOrthographic: own.camerasOrthographic,
      camerasPerspective: own.camerasPerspective,
      // `own` only, never `placed`: this measures what the SCENE holds, and a
      // count that silently folded in every placed prefab's objects would say
      // a scene is populated when all it has is one prefab instance.
      gameObjects: own.gameObjects,
      prefabInstances: own.prefabInstances,
      scripts: [...own.scripts].sort(),
    });
  }

  // ── Art inventory and what nothing binds ──────────────────────────────
  const artFiles = io
    .listFiles(assetsRoot, (f) => /\.(?:prefab|fbx|obj|blend|dae|gltf|glb|png|jpg|jpeg|psd|tga|exr|wav|ogg|mp3|aif|aiff|flac)$/iu.test(f))
    .map((f) => relative(projectRoot, f).split(sep).join("/"))
    // A fixture under Tests/ or Editor/ is not the game's unshipped art.
    .filter((rel) => !/(^|\/)(Tests?|Editor)\//i.test(rel));
  if (lastWalkVisitCapHit) {
    incomplete.push(`the art walk stopped after visiting ${WALK_VISIT_CAP} entries — the art inventory and the unbound lists are partial`);
  }
  if (artFiles.length >= walkBudget) {
    incomplete.push(
      `the art walk returned its maximum of ${walkBudget} files — the art inventory and the unbound lists are partial`,
    );
  }
  const pathToGuid = new Map<string, string>();
  for (const [guid, path] of guidToPath) pathToGuid.set(path, guid);

  const unboundPrefabs: string[] = [];
  const unboundModels: string[] = [];
  const unboundSprites: string[] = [];
  const placeholderSpritePaths: string[] = [];
  const realSpritePaths: string[] = [];
  const audioHashes = new Map<string, string>();
  const duplicateAudioPaths: string[] = [];
  const shortAudioPaths: string[] = [];
  let audio = 0;
  let prefabs = 0;
  let models = 0;
  let sprites = 0;
  for (const rel of artFiles) {
    const guid = pathToGuid.get(rel);
    const bound = guid !== undefined && boundGuids.has(guid);
    if (guid === undefined) {
      // No .meta on disk: Unity has not imported it, and this check cannot say
      // whether anything binds it. Counted as inventory, never as unbound.
      incomplete.push(`${rel} has no .meta sidecar — whether anything binds it is unmeasured`);
    }
    if (rel.endsWith(".prefab")) {
      prefabs++;
      if (guid !== undefined && !bound) unboundPrefabs.push(rel);
    } else if (MODEL_EXT_RE.test(rel)) {
      models++;
      if (guid !== undefined && !bound) unboundModels.push(rel);
    } else if (SPRITE_EXT_RE.test(rel)) {
      sprites++;
      if (guid !== undefined && !bound) unboundSprites.push(rel);
      if (isPlaceholderGradePng(join(projectRoot, rel))) placeholderSpritePaths.push(rel);
      else realSpritePaths.push(rel);
    } else if (AUDIO_EXT_RE.test(rel)) {
      audio++;
      const clip = measureAudioClip(join(projectRoot, rel));
      if (clip.hash !== undefined) {
        const twin = audioHashes.get(clip.hash);
        if (twin !== undefined) duplicateAudioPaths.push(`${rel} = ${twin}`);
        else audioHashes.set(clip.hash, rel);
      }
      if (clip.seconds !== undefined && clip.seconds < SHORT_AUDIO_SECONDS) shortAudioPaths.push(rel);
    }
  }

  // ── Geometry built in code ────────────────────────────────────────────
  const primitiveScripts: string[] = [];
  let primitiveCallSites = 0;
  for (const rel of files) {
    if (!rel.endsWith(".cs") || !isRuntimeScript(rel)) continue;
    let text: string;
    try {
      text = io.readFile(join(projectRoot, rel));
    } catch {
      continue;
    }
    const clean = stripComments(text);
    if (PRIMITIVE_RE.test(clean)) {
      primitiveScripts.push(rel);
      primitiveCallSites += (clean.match(/\bCreatePrimitive\s*\(/gu) ?? []).length;
    }
  }

  const shippedScenes = scenes.filter((s) => !s.scaffolding && !s.missing);
  const sum = (pick: (s: SceneStructure) => number): number =>
    shippedScenes.reduce((total, s) => total + pick(s), 0);
  const shippedRenderers = sum((s) => s.renderersInScene + s.renderersInPlacedPrefabs);
  const shippedWorldRenderers = sum((s) => s.worldRenderersShipped);
  const referencedOnlyRenderers = sum((s) => s.renderersInReferencedPrefabs);
  const shippedProjectRefs = sum((s) => s.projectRefs);
  const shippedBuiltInRefs = sum((s) => s.builtInRefs);
  const artTotal = prefabs + models + sprites;
  const unboundTotal = unboundPrefabs.length + unboundModels.length + unboundSprites.length;

  const report = {
    ...empty,
    measured: true,
    scenes,
    shippedScenes,
    shippedRenderers,
    shippedWorldRenderers,
    referencedOnlyRenderers,
    shippedProjectRefs,
    shippedBuiltInRefs,
    shippedMeshRenderers: sum((s) => s.meshRenderers),
    shippedSpriteRenderers: sum((s) => s.spriteRenderers),
    artInventory: {
      prefabs,
      models,
      sprites,
      placeholderSprites: placeholderSpritePaths.length,
      audio,
      duplicateAudio: duplicateAudioPaths.length,
      shortAudio: shortAudioPaths.length,
    },
    unboundPrefabs,
    unboundModels,
    unboundSprites,
    placeholderSpritePaths,
    primitiveScripts,
    primitiveCallSites,
    incomplete,
  };

  // ── Disclosure, always ────────────────────────────────────────────────
  const scaffolds = scenes.filter((s) => s.scaffolding);
  disclosures.push(
    `${enabled.length} scene${enabled.length === 1 ? "" : "s"} enabled in Build Settings; ` +
      `entry scene (build index 0): ${enabled[0] ?? "none"}` +
      (scaffolds.length > 0
        ? `; ${scaffolds.length} of them are test scaffolding (${scaffolds.map((s) => basename(s.scene)).slice(0, 4).join(", ")}${scaffolds.length > 4 ? ", …" : ""})`
        : ""),
  );
  const entryStructure = scenes.find((s) => s.scene === enabled[0]);
  if (entryStructure) {
    disclosures.push(
      `The entry scene ${entryStructure.scene} holds ${describeSceneComposition(entryStructure)}.`,
    );
  }
  disclosures.push(
    `Shipped scenes PLACE ${shippedRenderers} renderer component${shippedRenderers === 1 ? "" : "s"} ` +
      `(${report.shippedMeshRenderers} mesh, ${report.shippedSpriteRenderers} sprite), binding ` +
      `${shippedProjectRefs} project material/mesh/sprite reference${shippedProjectRefs === 1 ? "" : "s"} and ` +
      `${shippedBuiltInRefs} Unity built-in one${shippedBuiltInRefs === 1 ? "" : "s"}.`,
  );
  if (referencedOnlyRenderers > 0) {
    disclosures.push(
      `A further ${referencedOnlyRenderers} renderer component(s) sit in prefabs the shipped scenes only ` +
        "REFERENCE (through config assets or serialized script fields) and never place — they reach the screen " +
        "only if code instantiates them at runtime, which a file scan cannot verify.",
    );
  }
  disclosures.push(
    `Project art: ${prefabs} prefabs, ${models} imported models, ${sprites} sprite textures — ` +
      `${unboundTotal} of them (${unboundPrefabs.length} prefabs, ${unboundModels.length} models, ` +
      `${unboundSprites.length} sprites) are reached by no enabled scene.` +
      (placeholderSpritePaths.length > 0
        ? ` ${placeholderSpritePaths.length} of the ${sprites} sprite textures are placeholder-grade: ` +
          `their PNG compresses below ${PLACEHOLDER_BYTES_PER_PIXEL} byte per pixel, which is a flat ` +
          `procedural shape, not drawn art (e.g. ${placeholderSpritePaths.slice(0, 3).join(", ")}).` +
          // What is already real, so a sprint does not redraw it. Measured
          // 2026-09-07 15:30: an attempt spent its first 13 minutes rediscovering
          // which of the 429 sprites the previous attempt had drawn.
          (realSpritePaths.length > 0
            ? ` ${realSpritePaths.length} are real art already (newest first: ${newestFirst(projectRoot, realSpritePaths).slice(0, 6).join(", ")}${realSpritePaths.length > 6 ? ", …" : ""}).`
            : "")
        : ""),
  );
  disclosures.push(
    audio === 0
      ? "Project audio: no audio clips under Assets/ at all."
      : `Project audio: ${audio} clip${audio === 1 ? "" : "s"}, ${audio - duplicateAudioPaths.length} distinct by content` +
        (duplicateAudioPaths.length > 0
          ? ` (${duplicateAudioPaths.length} byte-identical to another: ${duplicateAudioPaths.slice(0, 2).join("; ")})`
          : "") +
        (shortAudioPaths.length > 0
          ? `; ${shortAudioPaths.length} shorter than ${SHORT_AUDIO_SECONDS}s (e.g. ${shortAudioPaths.slice(0, 3).join(", ")})`
          : "") +
        ".",
  );
  if (primitiveScripts.length > 0) {
    disclosures.push(
      `${primitiveScripts.length} runtime script${primitiveScripts.length === 1 ? "" : "s"} build geometry with ` +
        `CreatePrimitive/PrimitiveType: ${primitiveScripts.slice(0, 5).join(", ")}` +
        (primitiveScripts.length > 5 ? `, +${primitiveScripts.length - 5} more` : ""),
    );
  }

  // ── Refusal: only the strong, unambiguous case ────────────────────────
  const refusal =
    structuralRefusal(report, {
      artTotal,
      unboundTotal,
      entryScene: enabled[0],
    }) ?? placeholderArtRefusal(report);
  if (!refusal && artTotal === 0) {
    disclosures.push(
      "The project holds no prefabs, imported models or sprite textures at all — there is nothing to bind, " +
        "so no structural claim about unbound art is possible.",
    );
  }
  return { ...report, disclosures, refusal };
}

/**
 * The cases where refusing to deliver is the right answer.
 *
 * A. The shipped scenes place NO renderer at all, and either
 *    A1. nothing they even reference renders either — the delivery draws
 *        nothing by any route; or
 *    A2. runtime scripts build the visible world with GameObject.
 *        CreatePrimitive — what the player sees is engine primitives, not the
 *        project's art. This is the delivered PixelFlow build exactly: 0
 *        renderers placed across 13 non-scaffolding scenes, five scripts
 *        calling CreatePrimitive, and a grid of flat squares with four spheres
 *        on screen.
 *    Bare "places nothing" is NOT enough on its own: a game that instantiates
 *    its prefabs from a config at runtime legitimately ships scenes with no
 *    placed renderer, and refusing that would be a false accusation. That case
 *    gets the referenced-only-renderers disclosure instead.
 *
 * B. Every renderer they do place is a Unity built-in primitive/material —
 *    zero project materials, meshes or sprites — while the project holds art
 *    no enabled scene reaches.
 *
 * Both require the project to hold art at all: with nothing to bind, there is
 * no claim to make. Everything softer — some placeholders, a mostly-sprite
 * look, unbound art beside a scene that does bind some — is disclosure. A
 * stylised look can legitimately be built from sprites and built-in quads, and
 * this file cannot tell that apart from slop; the report says what it measured
 * and the reader judges.
 */
/**
 * What one scene FILE holds, in a clause a sprint can act on.
 *
 * A scene that is nearly empty is the most actionable fact the structural
 * check has, and reporting only its renderer count hid it (audited
 * 2026-09-04).
 */
export function describeSceneComposition(scene: SceneStructure): string {
  if (scene.missing) return "the file is not on disk";
  const parts = [
    `${scene.gameObjects} GameObject${scene.gameObjects === 1 ? "" : "s"}`,
    `${scene.prefabInstances} placed prefab instance${scene.prefabInstances === 1 ? "" : "s"}`,
  ];
  if (scene.scripts.length > 0) {
    const shown = scene.scripts.slice(0, 6);
    parts.push(
      `script${scene.scripts.length === 1 ? "" : "s"} ${shown.join(", ")}` +
        (scene.scripts.length > shown.length ? `, +${scene.scripts.length - shown.length} more` : ""),
    );
  }
  return parts.join(", ");
}

function structuralRefusal(
  report: Omit<BuiltAsSpecifiedReport, "refusal" | "disclosures">,
  totals: { artTotal: number; unboundTotal: number; entryScene?: string },
): string | undefined {
  const { shippedScenes, shippedRenderers, shippedProjectRefs } = report;
  if (shippedScenes.length === 0) return undefined;
  if (totals.artTotal === 0) return undefined;

  // The entry scene is build index 0, whatever it is; when that slot holds
  // scaffolding the message says so rather than promoting the next scene.
  const entryScene = totals.entryScene ?? shippedScenes[0]!.scene;
  const entryRecord = report.scenes.find((s) => s.scene === entryScene);
  const entry = `entry scene (build index 0) ${entryScene}${
    totals.entryScene !== undefined && shippedScenes[0]?.scene !== totals.entryScene
      ? entryRecord?.missing
        ? " — missing from disk"
        : " — itself test scaffolding"
      : ""
  }`;
  // The one fact that tells a bounced sprint where to start: how empty the
  // scene it must fill actually is (audited 2026-09-04).
  const entryStructure = report.scenes.find((s) => s.scene === entryScene);
  const entryHolds = entryStructure
    ? ` That scene holds ${describeSceneComposition(entryStructure)}.`
    : "";
  const unboundSample = [
    ...report.unboundPrefabs.slice(0, 3),
    ...report.unboundModels.slice(0, 3),
    ...report.unboundSprites.slice(0, 2),
  ];
  const unboundText =
    totals.unboundTotal === 0
      ? "no unbound art"
      : `${report.unboundPrefabs.length} prefabs, ${report.unboundModels.length} imported models and ` +
        `${report.unboundSprites.length} sprite textures that no enabled scene reaches` +
        (unboundSample.length > 0 ? ` (e.g. ${unboundSample.join(", ")})` : "");

  // UI canvases and video do not count as the world (review 2026-09-07), and
  // ONE runtime script touching PrimitiveType (a fade quad) does not turn a
  // game whose art is referenced from a config into "primitives" — two or
  // more do.
  const uiOnly = shippedRenderers - report.shippedWorldRenderers;
  const primitivesAreTheWorld =
    report.primitiveCallSites >= 2 || (report.referencedOnlyRenderers === 0 && report.primitiveScripts.length > 0);
  if (report.shippedWorldRenderers === 0 && (report.referencedOnlyRenderers === 0 || primitivesAreTheWorld)) {
    return (
      `The shipped scenes render NOTHING: across ${shippedScenes.length} enabled non-scaffolding ` +
      `scene${shippedScenes.length === 1 ? "" : "s"} — ${entry} — there are 0 world renderer ` +
      `components (0 MeshRenderer/SkinnedMeshRenderer, 0 SpriteRenderer${uiOnly > 0 ? `; ${uiOnly} UI CanvasRenderer/VideoPlayer do not count` : ""}), in the scenes themselves and in ` +
      `every prefab they place.${entryHolds} Meanwhile the project holds ${report.artInventory.prefabs} prefabs, ` +
      `${report.artInventory.models} imported models and ${report.artInventory.sprites} sprite textures, of ` +
      `which ${unboundText}.` +
      (report.primitiveScripts.length > 0
        ? ` What is visible at runtime is built by ${report.primitiveScripts.length} script(s) calling ` +
          `GameObject.CreatePrimitive (${report.primitiveScripts.slice(0, 3).join(", ")}) — engine primitives, not the game's art.`
        : "") +
      (report.referencedOnlyRenderers > 0
        ? ` ${report.referencedOnlyRenderers} renderer(s) do exist in prefabs the scenes reference but never place; ` +
          "bind them in the scene (or prove at runtime that they are what the player sees) instead of drawing primitives."
        : "") +
      // The way out, by name. Measured 2026-09-07: eight attempts on this
      // refusal with no deterministic tool to act on it.
      " Deterministic path: unity_bind_sprite (a prefab's SpriteRenderer → a real sprite) and unity_place_prefab " +
      "(that prefab into the entry scene) — no Editor, verified on write; then unity_playmode_verify with capture."
    );
  }

  if (shippedProjectRefs === 0 && report.shippedBuiltInRefs > 0 && totals.unboundTotal > 0) {
    const ids = [...new Set(shippedScenes.flatMap((s) => s.builtInIds))].slice(0, 4);
    return (
      `Every renderer the shipped scenes have is a Unity built-in: ${shippedRenderers} renderer ` +
      `component${shippedRenderers === 1 ? "" : "s"} across ${shippedScenes.length} scene(s) — ${entry} — ` +
      `reference ${report.shippedBuiltInRefs} built-in id(s)` +
      (ids.length > 0 ? ` (${ids.join(", ")})` : "") +
      ` and 0 project materials, meshes or sprites.${entryHolds} Meanwhile the project holds ${unboundText}.`
    );
  }

  return undefined;
}

/**
 * Compressed bytes per pixel below which a PNG is a flat shape rather than art.
 *
 * Measured 2026-09-06 across the 428 sprites of the PixelFlow lease: 409 sat
 * under 0.1 (median 0.07 — 281 bytes for 64×64), the 19 drawn ones between
 * 0.28 and 0.67, and nothing in between. A real 64×64 sprite cannot compress
 * to 400 bytes; a solid square with an outline always does.
 */
export const PLACEHOLDER_BYTES_PER_PIXEL = 0.1;

/** Share of placeholder-grade sprites (and minimum count) at which the art is placeholder art. */
const PLACEHOLDER_REFUSAL_SHARE = 0.8;
const PLACEHOLDER_REFUSAL_MIN_SPRITES = 10;

/** Width and height from a PNG's IHDR, or null for anything that is not a readable PNG. */
export function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Content hash and, for a WAV, the duration its header declares. Unreadable → both undefined. */
export function measureAudioClip(absPath: string): { hash?: string; seconds?: number } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(absPath);
  } catch {
    return {};
  }
  const hash = createHash("sha1").update(bytes).digest("hex");
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    return { hash };
  }
  // Walk the chunks: fmt gives rate/channels/bits, data gives the byte count.
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let dataBytes: number | undefined;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString("ascii", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === "fmt " && at + 24 <= bytes.length) {
      channels = bytes.readUInt16LE(at + 10);
      rate = bytes.readUInt32LE(at + 12);
      bits = bytes.readUInt16LE(at + 22);
    } else if (id === "data") {
      // A streaming encoder writes size 0 (or 0xFFFFFFFF): the data runs to
      // the end of the file, not for zero seconds (review 2026-09-07).
      const remaining = bytes.length - at - 8;
      dataBytes = size === 0 || size > remaining ? remaining : size;
      break;
    }
    at += 8 + size + (size % 2);
  }
  const bytesPerSecond = rate * channels * (bits / 8);
  return dataBytes !== undefined && bytesPerSecond > 0 ? { hash, seconds: dataBytes / bytesPerSecond } : { hash };
}

/** Paths ordered by mtime, newest first; unreadable ones last. */
function newestFirst(projectRoot: string, rels: readonly string[]): string[] {
  const stamped = rels.map((rel) => {
    try {
      return { rel, mtime: statSync(join(projectRoot, rel)).mtimeMs };
    } catch {
      return { rel, mtime: 0 };
    }
  });
  return stamped.sort((a, b) => b.mtime - a.mtime).map((s) => s.rel);
}

/**
 * Decode an 8-bit, non-interlaced PNG (grey, RGB, palette, grey+alpha, RGBA;
 * 16-bit takes the high byte) to RGBA. Null for anything else, or anything
 * larger than the decode budget.
 */
export function decodePngRgba(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } | null {
  const dims = readPngDimensions(bytes);
  if (dims === null || dims.width * dims.height > PNG_DECODE_MAX_PIXELS) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bitDepth = bytes[24]!;
  const colorType = bytes[25]!;
  const interlace = bytes[28]!;
  if (interlace !== 0 || (bitDepth !== 8 && bitDepth !== 16)) return null;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number | undefined>)[colorType];
  if (channels === undefined) return null;
  const idat: Uint8Array[] = [];
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  let at = 8;
  while (at + 8 <= bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === "IDAT") idat.push(data);
    else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IEND") break;
    at += 12 + len;
  }
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c))));
  } catch {
    return null;
  }
  const bytesPerSample = bitDepth / 8;
  const bpp = channels * bytesPerSample;
  const stride = dims.width * bpp;
  if (raw.length < (stride + 1) * dims.height) return null;
  const rgba = new Uint8Array(dims.width * dims.height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let inAt = 0;
  for (let y = 0; y < dims.height; y++) {
    const filter = raw[inAt++]!;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp]! : 0;
      const b = prev[x]!;
      const c = x >= bpp ? prev[x - bpp]! : 0;
      let v = raw[inAt + x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
    inAt += stride;
    for (let px = 0; px < dims.width; px++) {
      const o = (y * dims.width + px) * 4;
      const i = px * bpp;
      const sample = (k: number): number => cur[i + k * bytesPerSample]!;
      if (colorType === 6) { rgba[o] = sample(0); rgba[o + 1] = sample(1); rgba[o + 2] = sample(2); rgba[o + 3] = sample(3); }
      else if (colorType === 2) { rgba[o] = sample(0); rgba[o + 1] = sample(1); rgba[o + 2] = sample(2); rgba[o + 3] = 255; }
      else if (colorType === 0) { const g = sample(0); rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255; }
      else if (colorType === 4) { const g = sample(0); rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = sample(1); }
      else {
        const idx = cur[i]!;
        rgba[o] = palette?.[idx * 3] ?? 0;
        rgba[o + 1] = palette?.[idx * 3 + 1] ?? 0;
        rgba[o + 2] = palette?.[idx * 3 + 2] ?? 0;
        rgba[o + 3] = trns !== undefined && idx < trns.length ? trns[idx]! : 255;
      }
    }
    prev.set(cur);
  }
  return { width: dims.width, height: dims.height, rgba };
}

const PNG_DECODE_MAX_PIXELS = 4_194_304;
/** Distinct colours (4 bits per channel, transparent folded to one) at or below which an image is flat shapes. */
const PLACEHOLDER_MAX_COLOURS = 12;
/** Share of sampled pixels whose right or lower neighbour differs — flat shapes have edges only on their outlines. */
const PLACEHOLDER_MAX_EDGE_SHARE = 0.2;

/**
 * What the PIXELS say (review 2026-09-07): the byte-per-pixel heuristic was
 * resolution-dependent — pixel art exported at 8× and a 256 px anti-aliased
 * icon fell under the threshold, while a 300-byte square with a 3 KB iCCP
 * chunk or a stored (level 0) deflate rose above it. A placeholder is a flat
 * shape: a handful of colours and edges only along its outlines. Sampled on
 * a ≤64×64 grid so a 2048² texture costs the same as a sprite.
 */
export function measurePngContent(bytes: Uint8Array): { colours: number; edgeShare: number } | null {
  const decoded = decodePngRgba(bytes);
  if (decoded === null) return null;
  const { width, height, rgba } = decoded;
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 64));
  const key = (x: number, y: number): number => {
    const o = (y * width + x) * 4;
    const a = rgba[o + 3]!;
    if (a < 16) return -1;
    return ((rgba[o]! >> 4) << 12) | ((rgba[o + 1]! >> 4) << 8) | ((rgba[o + 2]! >> 4) << 4) | (a >> 4);
  };
  const colours = new Set<number>();
  let sampled = 0;
  let edges = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const k = key(x, y);
      colours.add(k);
      sampled++;
      // The NEXT grid sample, not the adjacent pixel: pixel art exported at
      // 8× or 16× keeps its edge density this way, a flat disc does not.
      const right = x + step < width ? key(x + step, y) : k;
      const down = y + step < height ? key(x, y + step) : k;
      if (right !== k || down !== k) edges++;
    }
  }
  return { colours: colours.size, edgeShare: sampled === 0 ? 0 : edges / sampled };
}

/** The bytes inside IDAT only — metadata chunks are not image content. */
function pngIdatBytes(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let total = 0;
  let found = false;
  while (at + 8 <= bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    if (type === "IDAT") { total += len; found = true; }
    if (type === "IEND") break;
    at += 12 + len;
  }
  // No IDAT chunk at all: not a PNG this reader understands (a truncated or
  // synthetic file) — the whole file is the only measure there is.
  return found ? total : bytes.length;
}

/**
 * True only for a PNG that was read, decoded and measured as flat shapes.
 * When the pixels cannot be decoded (interlaced, exotic depth, oversized)
 * the IDAT bytes-per-pixel heuristic decides. Unreadable is not placeholder.
 */
export function isPlaceholderGradePng(absPath: string): boolean {
  if (!/\.png$/iu.test(absPath)) return false;
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(absPath);
  } catch {
    return false;
  }
  const dims = readPngDimensions(bytes);
  if (dims === null) return false;
  const content = measurePngContent(bytes);
  if (content !== null) {
    return content.colours <= PLACEHOLDER_MAX_COLOURS && content.edgeShare <= PLACEHOLDER_MAX_EDGE_SHARE;
  }
  return pngIdatBytes(bytes) / (dims.width * dims.height) < PLACEHOLDER_BYTES_PER_PIXEL;
}

/**
 * C. The project's sprite art is, in the overwhelming majority, placeholder
 *    shapes. A stylised game can be flat-shaded; a game whose "artwork" files
 *    are 300-byte squares has not had its art made. Strong case only: at least
 *    PLACEHOLDER_REFUSAL_MIN_SPRITES sprites and PLACEHOLDER_REFUSAL_SHARE of
 *    them placeholder-grade. Anything softer is the disclosure above.
 */
function placeholderArtRefusal(
  report: Omit<BuiltAsSpecifiedReport, "refusal" | "disclosures">,
): string | undefined {
  const { sprites, placeholderSprites } = report.artInventory;
  if (sprites < PLACEHOLDER_REFUSAL_MIN_SPRITES) return undefined;
  if (placeholderSprites / sprites < PLACEHOLDER_REFUSAL_SHARE) return undefined;
  return (
    `The project's art is placeholder art: ${placeholderSprites} of ${sprites} sprite textures compress ` +
    `below ${PLACEHOLDER_BYTES_PER_PIXEL} byte per pixel — flat procedural shapes, not drawn art ` +
    `(e.g. ${report.placeholderSpritePaths.slice(0, 4).join(", ")}). A solid square is not a delivered ` +
    `game. Replace them with real art: unity_generate_sprite with provider "local" (the open-weights ` +
    `model on this machine), or a purchased package via unity_my_assets_cloud (search → download) and ` +
    `unity_import_asset_package — then bind the imported sprites where the placeholders are bound.`
  );
}

/** Every guid a Unity text asset mentions. */
function collectGuids(text: string): string[] {
  const out: string[] = [];
  const re = /guid:\s*([0-9a-f]{32})/giu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const guid = m[1]!.toLowerCase();
    if (!UNITY_BUILT_IN_GUIDS.has(guid) && !/^0{32}$/.test(guid)) out.push(guid);
  }
  return out;
}
