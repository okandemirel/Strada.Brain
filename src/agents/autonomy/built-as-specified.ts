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

function walk(dir: string, match?: (file: string) => boolean, budget = ASSET_WALK_BUDGET): string[] {
  const out: string[] = [];
  const stack = [dir];
  let visited = 0;
  while (stack.length > 0 && out.length < budget && visited < 120_000) {
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
]);

/** Renderer classes that draw actual 3D geometry (item 2's disclosure). */
const MESH_RENDERER_CLASSES: ReadonlySet<string> = new Set([
  "MeshRenderer",
  "SkinnedMeshRenderer",
]);

const MODEL_EXT_RE = /\.(?:fbx|obj|blend|dae|gltf|glb|3ds|max|ma|mb)$/iu;
const SPRITE_EXT_RE = /\.(?:png|jpg|jpeg|psd|tga|exr|tif|tiff)$/iu;
const FOLLOWABLE_EXT_RE = /\.(?:prefab|asset|unity|mat|controller|playable|spriteatlas)$/iu;

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
}

export interface ArtInventory {
  readonly prefabs: number;
  readonly models: number;
  readonly sprites: number;
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
  /** Runtime scripts that build geometry with CreatePrimitive/PrimitiveType. */
  readonly primitiveScripts: readonly string[];
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
  const flush = (): void => {
    if (className !== undefined) docs.push({ className, lines });
    className = undefined;
    lines = [];
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("--- !u!")) {
      flush();
      className = "";
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
}

function newTally(): Tally {
  return {
    renderers: 0,
    meshRenderers: 0,
    spriteRenderers: 0,
    projectRefs: 0,
    builtInRefs: 0,
    builtInIds: new Set(),
    refGuids: new Set(),
    prefabGuids: new Set(),
    camerasOrthographic: 0,
    camerasPerspective: 0,
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
      if (MESH_RENDERER_CLASSES.has(doc.className)) tally.meshRenderers++;
      if (doc.className === "SpriteRenderer") tally.spriteRenderers++;
    }
    const wantsRefs = isRenderer || doc.className === "MeshFilter";
    let inMaterialList = false;
    for (const line of doc.lines) {
      const keyed = /^\s*([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
      if (keyed) {
        const key = keyed[1]!;
        const rest = keyed[2]!;
        inMaterialList = wantsRefs && key === "m_Materials" && rest.trim() === "";
        if (doc.className === "Camera" && key === "orthographic") {
          if (rest.trim() === "1") tally.camerasOrthographic++;
          else if (rest.trim() === "0") tally.camerasPerspective++;
        }
        if (doc.className === "PrefabInstance" && key === "m_SourcePrefab") {
          const ref = parseRef(rest);
          if (ref?.guid && classifyRef(ref) === "project") tally.prefabGuids.add(ref.guid);
        }
        if (wantsRefs && (key === "m_Sprite" || key === "m_Mesh")) {
          const ref = parseRef(rest);
          if (ref) recordRef(ref, tally);
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
  for (const line of text.split("\n")) {
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
    referencedOnlyRenderers: 0,
    shippedProjectRefs: 0,
    shippedBuiltInRefs: 0,
    shippedMeshRenderers: 0,
    shippedSpriteRenderers: 0,
    artInventory: { prefabs: 0, models: 0, sprites: 0 },
    unboundPrefabs: [] as string[],
    unboundModels: [] as string[],
    unboundSprites: [] as string[],
    primitiveScripts: [] as string[],
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
    .listFiles(assetsRoot, (f) => /\.(?:meta|prefab|asset|unity|cs)$/iu.test(f))
    .map((f) => relative(projectRoot, f).split(sep).join("/"));
  const fileSet = new Set(files);
  if (files.length >= walkBudget) {
    incomplete.push(
      `the Assets/ scene-and-script walk returned its maximum of ${walkBudget} files — guids, prefabs and ` +
        "scripts beyond that were not read, so art may be reported as unbound when it is not",
    );
  }

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
    for (const g of collectGuids(sceneText)) {
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
    });
  }

  // ── Art inventory and what nothing binds ──────────────────────────────
  const artFiles = io
    .listFiles(assetsRoot, (f) => /\.(?:prefab|fbx|obj|blend|dae|gltf|glb|png|jpg|jpeg|psd|tga|exr)$/iu.test(f))
    .map((f) => relative(projectRoot, f).split(sep).join("/"))
    // A fixture under Tests/ or Editor/ is not the game's unshipped art.
    .filter((rel) => !/(^|\/)(Tests?|Editor)\//i.test(rel));
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
    }
  }

  // ── Geometry built in code ────────────────────────────────────────────
  const primitiveScripts: string[] = [];
  for (const rel of files) {
    if (!rel.endsWith(".cs") || !isRuntimeScript(rel)) continue;
    let text: string;
    try {
      text = io.readFile(join(projectRoot, rel));
    } catch {
      continue;
    }
    if (PRIMITIVE_RE.test(stripComments(text))) primitiveScripts.push(rel);
  }

  const shippedScenes = scenes.filter((s) => !s.scaffolding && !s.missing);
  const sum = (pick: (s: SceneStructure) => number): number =>
    shippedScenes.reduce((total, s) => total + pick(s), 0);
  const shippedRenderers = sum((s) => s.renderersInScene + s.renderersInPlacedPrefabs);
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
    referencedOnlyRenderers,
    shippedProjectRefs,
    shippedBuiltInRefs,
    shippedMeshRenderers: sum((s) => s.meshRenderers),
    shippedSpriteRenderers: sum((s) => s.spriteRenderers),
    artInventory: { prefabs, models, sprites },
    unboundPrefabs,
    unboundModels,
    unboundSprites,
    primitiveScripts,
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
      `${unboundSprites.length} sprites) are reached by no enabled scene.`,
  );
  if (primitiveScripts.length > 0) {
    disclosures.push(
      `${primitiveScripts.length} runtime script${primitiveScripts.length === 1 ? "" : "s"} build geometry with ` +
        `CreatePrimitive/PrimitiveType: ${primitiveScripts.slice(0, 5).join(", ")}` +
        (primitiveScripts.length > 5 ? `, +${primitiveScripts.length - 5} more` : ""),
    );
  }

  // ── Refusal: only the strong, unambiguous case ────────────────────────
  const refusal = structuralRefusal(report, {
    artTotal,
    unboundTotal,
    entryScene: enabled[0],
  });
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
  const entry = `entry scene (build index 0) ${entryScene}${
    totals.entryScene !== undefined && shippedScenes[0]?.scene !== totals.entryScene
      ? " — itself test scaffolding"
      : ""
  }`;
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

  if (shippedRenderers === 0 && (report.referencedOnlyRenderers === 0 || report.primitiveScripts.length > 0)) {
    return (
      `The shipped scenes render NOTHING: across ${shippedScenes.length} enabled non-scaffolding ` +
      `scene${shippedScenes.length === 1 ? "" : "s"} — ${entry} — there are 0 renderer ` +
      `components (0 MeshRenderer/SkinnedMeshRenderer, 0 SpriteRenderer), in the scenes themselves and in ` +
      `every prefab they place. Meanwhile the project holds ${report.artInventory.prefabs} prefabs, ` +
      `${report.artInventory.models} imported models and ${report.artInventory.sprites} sprite textures, of ` +
      `which ${unboundText}.` +
      (report.primitiveScripts.length > 0
        ? ` What is visible at runtime is built by ${report.primitiveScripts.length} script(s) calling ` +
          `GameObject.CreatePrimitive (${report.primitiveScripts.slice(0, 3).join(", ")}) — engine primitives, not the game's art.`
        : "") +
      (report.referencedOnlyRenderers > 0
        ? ` ${report.referencedOnlyRenderers} renderer(s) do exist in prefabs the scenes reference but never place; ` +
          "bind them in the scene (or prove at runtime that they are what the player sees) instead of drawing primitives."
        : "")
    );
  }

  if (shippedProjectRefs === 0 && report.shippedBuiltInRefs > 0 && totals.unboundTotal > 0) {
    const ids = [...new Set(shippedScenes.flatMap((s) => s.builtInIds))].slice(0, 4);
    return (
      `Every renderer the shipped scenes have is a Unity built-in: ${shippedRenderers} renderer ` +
      `component${shippedRenderers === 1 ? "" : "s"} across ${shippedScenes.length} scene(s) — ${entry} — ` +
      `reference ${report.shippedBuiltInRefs} built-in id(s)` +
      (ids.length > 0 ? ` (${ids.join(", ")})` : "") +
      ` and 0 project materials, meshes or sprites. Meanwhile the project holds ${unboundText}.`
    );
  }

  return undefined;
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
