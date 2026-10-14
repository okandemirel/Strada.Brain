import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { isVendorPath, stripCsComments } from "./csharp-source.js";

/**
 * Whether a run delivered a game or a library.
 *
 * The conformance guard checks the shape of code: a module has a ModuleConfig
 * class, an .asmdef, tests. Every one of those can pass while nothing runs:
 * modules, C# files and test assemblies can all compile with no scene, no
 * ScriptableObject asset and no bootstrapper wiring, and such a run still
 * reports success. A developer opening that project finds a library.
 *
 * These checks read artifacts, not intentions, and they are ordered cheapest
 * first: does a scene exist at all, is there an asset for each config class, is
 * a bootstrapper actually wired to one. The last is the load-bearing one — a
 * `_gameConfig: {fileID: 0}` is a null that looks exactly like a link in every
 * view except the file itself.
 */

export interface SceneWiringProblem {
  readonly kind: "no-scene" | "missing-config-asset" | "no-bootstrapper" | "unwired-bootstrapper";
  readonly detail: string;
}

export interface SceneWiringReport {
  readonly wired: boolean;
  readonly scenes: readonly string[];
  readonly configClasses: readonly string[];
  readonly configAssets: readonly string[];
  readonly problems: readonly SceneWiringProblem[];
}

/** Injected so the checks can be tested without a Unity project on disk. */
export interface SceneWiringIo {
  /**
   * Files under `dir`. With `match`, only matching files are listed and — for
   * the on-disk walk — the budget counts matches rather than every file seen
   * (audited 2026-09-02: slicing an unfiltered listing let an imported asset
   * pack push the project's own .prefab/.cs/.unity files past the cap, and the
   * gates that read them silently evaluated to "no gate").
   */
  listFiles(dir: string, match?: (file: string) => boolean): string[];
  readFile(path: string): string;
  exists(path: string): boolean;
}

const defaultIo: SceneWiringIo = {
  listFiles: (dir, match) => walk(dir, match),
  readFile: (p) => readFileSync(p, "utf-8"),
  exists: (p) => existsSync(p),
};

/**
 * Bounded walk. The budget counts files that pass `match`, so an imported
 * pack of textures cannot exhaust it before the files a rule actually reads;
 * traversal itself stays hard-capped so a stray Library/ cannot hang a check.
 */
/** The default walk's match budget and visit cap; a replayed walk (project-walk.ts) uses the same. */
export const SCENE_WALK_BUDGET = 12_000;
export const SCENE_WALK_VISIT_CAP = 60_000;

function walk(dir: string, match?: (file: string) => boolean, budget = SCENE_WALK_BUDGET): string[] {
  const out: string[] = [];
  const stack = [dir];
  let visited = 0;
  while (stack.length > 0 && out.length < budget && visited < SCENE_WALK_VISIT_CAP) {
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

/** What each rule reads, so the walk budget is spent on exactly that. */
/**
 * The same bounded walk, for a reader outside this module (the project
 * inventory). Exported rather than re-implemented: a second walk with its own
 * budget would report a different project than the gates measure.
 */
export function walkFilesForInventory(dir: string, budget: number, match?: (file: string) => boolean): string[] {
  return walk(dir, match, budget);
}

const WIRING_FILE_RE = /\.(?:unity|asset)$/iu;
const isWiringFile = (f: string): boolean => WIRING_FILE_RE.test(f) || f.endsWith("ModuleConfig.cs");
const RENDER_FILE_RE = /\.(?:prefab|cs|unity)$/iu;
// Vendor code under Assets/Plugins is not the run's to answer for: a plugin's
// own Debug.Log calls or demo scenes held the bypass and camera gates shut
// after a one-line edit elsewhere (audited 2026-09-24).
const isRenderFile = (f: string): boolean => RENDER_FILE_RE.test(f) && !isVendorPath(f);
const isSourceFile = (f: string): boolean => f.endsWith(".cs") && !isVendorPath(f);

/**
 * A serialized object reference that is actually null.
 *
 * Unity writes an unassigned reference as `{fileID: 0}` — same field, same
 * shape, no guid. Checking that the field is present is not a check.
 */
function referenceIsNull(sceneText: string, fieldName: string): boolean | null {
  const match = new RegExp(`${fieldName}:\\s*\\{fileID:\\s*(-?\\d+)`).exec(sceneText);
  if (!match) return null;
  return match[1] === "0";
}

/**
 * Is this a base class rather than a module's own config?
 *
 * An abstract ModuleConfig has no asset by definition, so requiring one turns a
 * perfectly ordinary class hierarchy into an unclearable gate.
 */
function declaresAbstractConfig(path: string, io: SceneWiringIo): boolean {
  try {
    return /\babstract\s+(partial\s+)?class\b/.test(io.readFile(path));
  } catch {
    // Unreadable: no evidence that it is abstract, and no accusation either way
    // beyond what the asset check already makes.
    return false;
  }
}

/**
 * The guid Unity assigned to a script, from its .meta sidecar.
 *
 * An asset says which class it is by guid, never by file name — so a name is
 * the one thing that cannot answer "does an asset exist for this config".
 */
function scriptGuid(path: string, io: SceneWiringIo): string | undefined {
  try {
    return /^guid:\s*([0-9a-f]{32})\s*$/m.exec(io.readFile(`${path}.meta`))?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Config classes that some asset in the project is an instance of.
 *
 * unity_scene_build names its assets <Name>Module.asset while the class is
 * <Name>ModuleConfig, so comparing names accuses a correctly assembled scene
 * of being a library and sends the agent back to rebuild it.
 */
function classesWithAnAsset(
  files: readonly string[],
  configClasses: readonly string[],
  io: SceneWiringIo,
): Set<string> {
  const byGuid = new Map<string, string>();
  for (const cls of configClasses) {
    const guid = scriptGuid(cls, io);
    if (guid) byGuid.set(guid, basename(cls, ".cs"));
  }
  if (byGuid.size === 0) return new Set();

  const found = new Set<string>();
  for (const asset of files.filter((f) => f.endsWith(".asset"))) {
    let text: string;
    try {
      text = io.readFile(asset);
    } catch {
      continue;
    }
    const guid = /m_Script:\s*\{[^}]*\bguid:\s*([0-9a-f]{32})/i.exec(text)?.[1];
    const cls = guid === undefined ? undefined : byGuid.get(guid);
    if (cls !== undefined) found.add(cls);
  }
  return found;
}

export function assessSceneWiring(
  projectPath: string,
  io: SceneWiringIo = defaultIo,
): SceneWiringReport {
  const assetsRoot = join(projectPath, "Assets");
  const problems: SceneWiringProblem[] = [];

  if (!io.exists(assetsRoot)) {
    return {
      wired: false,
      scenes: [],
      configClasses: [],
      configAssets: [],
      problems: [{ kind: "no-scene", detail: "the project has no Assets directory" }],
    };
  }

  const files = io.listFiles(assetsRoot, isWiringFile);
  const scenes = files.filter((f) => f.endsWith(".unity"));
  const configClasses = files.filter((f) => f.endsWith("ModuleConfig.cs"));
  const configAssets = files.filter((f) => f.endsWith("ModuleConfig.asset"));

  if (scenes.length === 0) {
    problems.push({
      kind: "no-scene",
      detail: "no .unity scene was produced — code without a scene is a library, not a game",
    });
  }

  // A generated ModuleConfig CLASS does nothing until an ASSET exists for it:
  // the bootstrapper holds asset references, not types.
  const assetNames = new Set(configAssets.map((a) => basename(a, ".asset")));
  // By guid first, because that is what Unity actually uses; the name rule
  // stays as a fallback for a project whose .meta files are not on disk.
  const backed = classesWithAnAsset(files, configClasses, io);
  for (const cls of configClasses) {
    const name = basename(cls, ".cs");
    // A class under a Tests/ root is a double or a fixture, not a module's
    // config: demanding an asset for it blocks a correctly assembled game
    // because someone wrote a test.
    if (/\/Tests?\//i.test(cls.replace(/\\/g, "/"))) continue;
    // An abstract base is never instantiated as an asset either.
    if (declaresAbstractConfig(cls, io)) continue;

    if (!backed.has(name) && !assetNames.has(name)) {
      problems.push({
        kind: "missing-config-asset",
        detail: `${name}.cs has no ${name}.asset — the class exists but nothing references it`,
      });
    }
  }

  let sawBootstrapper = false;
  for (const scene of scenes) {
    let text: string;
    try {
      text = io.readFile(scene);
    } catch {
      continue;
    }
    if (!text.includes("_gameConfig")) continue;

    sawBootstrapper = true;
    const isNull = referenceIsNull(text, "_gameConfig");
    if (isNull === true) {
      problems.push({
        kind: "unwired-bootstrapper",
        detail: `${basename(scene)}: GameBootstrapper._gameConfig is {fileID: 0} — assigned to nothing`,
      });
    }
  }

  if (scenes.length > 0 && !sawBootstrapper) {
    problems.push({
      kind: "no-bootstrapper",
      detail: "no scene contains a GameBootstrapper — nothing will start the modules",
    });
  }

  return {
    wired: problems.length === 0,
    scenes,
    configClasses,
    configAssets,
    problems,
  };
}

/** Whether anything in the project can put a GameObject on screen. */
export interface ViewLayerAssessment {
  readonly hasViews: boolean;
  readonly prefabCount: number;
  readonly scriptCount: number;
  /** Scenes that hold no Camera. Without one, nothing is drawn at all. */
  readonly camerslessScenes: readonly string[];
}

/** Strada.Core's own bridge from simulation to scene, plus Unity's base class. */
const VIEW_MARKERS = [
  ": MonoBehaviour",
  "EntityView",
  "EntityMediator",
  "MediatorRegistry",
  "ViewRegistry",
  "ViewSyncRunner",
  "IViewPool",
  ": View\n",
  ": View ",
  "IView",
];

/**
 * Whether a run that built a game built anything that renders.
 *
 * A project can hold scripts, prefabs and passing play-mode tests and still
 * contain no MonoBehaviour or Strada.Core view type (View, EntityView,
 * EntityMediator, ViewRegistry). Tests that call services directly never go
 * through a scene, so they pass while nothing can be seen.
 *
 * Only accuses when there is something to render: prefabs exist and project
 * code was written. A simulation with no prefabs owes nobody a view.
 */
export function assessViewLayer(
  projectPath: string,
  io: SceneWiringIo = defaultIo,
): ViewLayerAssessment | null {
  const assets = join(projectPath, "Assets");
  if (!io.exists(assets)) return null;

  // Filtered inside the walk, not sliced after it (audited 2026-09-02): the
  // old `.slice(0, 4000)` of an unfiltered listing kept whatever subtree the
  // LIFO walk reached first — an imported pack — so no .prefab survived, this
  // returned null, and NO CAMERA / NOTHING RENDERS were skipped without any
  // record that they had been skipped rather than satisfied. The post-filter
  // stays for an injected io that ignores `match`.
  const files = io.listFiles(assets, isRenderFile).filter(isRenderFile);
  const prefabs = files.filter((f) => f.endsWith(".prefab"));
  const scripts = files.filter((f) => f.endsWith(".cs") && !/[/\\]Tests?[/\\]/u.test(f));
  if (prefabs.length === 0 || scripts.length === 0) return null;

  let viewScripts = 0;
  for (const script of scripts) {
    let text: string;
    try {
      text = stripCsComments(io.readFile(script), { blankStrings: true });
    } catch {
      continue;
    }
    if (VIEW_MARKERS.some((marker) => text.includes(marker))) viewScripts++;
  }

  // A scene with no camera renders nothing, whatever else is right.
  const cameraless: string[] = [];
  let cameraPrefabs: ReadonlySet<string> | null = null;
  for (const scene of files.filter((f) => f.endsWith(".unity"))) {
    let text: string;
    try {
      text = io.readFile(scene);
    } catch {
      continue;
    }
    if (/^Camera:/mu.test(text)) continue;
    // A camera placed as a prefab instance lives in the prefab's file, not
    // the scene's: such a scene was accused of holding no camera.
    cameraPrefabs ??= cameraPrefabGuids(prefabs, io);
    if (instancedPrefabGuids(text).some((guid) => cameraPrefabs!.has(guid))) continue;
    // The listing holds native paths: cutting at "/" alone left a Windows
    // path whole, so the report named the full path, not the scene.
    cameraless.push(scene.slice(Math.max(scene.lastIndexOf("/"), scene.lastIndexOf("\\")) + 1));
  }

  return {
    hasViews: viewScripts > 0,
    prefabCount: prefabs.length,
    scriptCount: scripts.length,
    camerslessScenes: cameraless,
  };
}

/** Guids of the prefabs a scene instantiates (its PrefabInstance documents). */
function instancedPrefabGuids(sceneText: string): string[] {
  return [...sceneText.matchAll(/m_SourcePrefab:\s*\{[^}]*guid:\s*([0-9a-f]{32})/gu)].map((m) => m[1]!);
}

/** Guids of the prefabs that carry a Camera component. */
function cameraPrefabGuids(prefabs: readonly string[], io: SceneWiringIo): ReadonlySet<string> {
  const guids = new Set<string>();
  for (const prefab of prefabs) {
    try {
      if (!/^Camera:/mu.test(io.readFile(prefab))) continue;
      const guid = /^guid:\s*([0-9a-f]{32})\s*$/mu.exec(io.readFile(`${prefab}.meta`))?.[1];
      if (guid) guids.add(guid);
    } catch {
      // Unreadable prefab or meta: no evidence of a camera.
    }
  }
  return guids;
}

/** A thing the project built for itself that Strada.Core already provides. */
export interface FrameworkBypass {
  readonly what: string;
  readonly count: number;
  readonly instead: string;
}

const BYPASS_RULES: ReadonlyArray<{
  what: string;
  mine: RegExp;
  theirs: RegExp;
  instead: string;
  floor: number;
}> = [
  {
    what: "hand-rolled C# events",
    mine: /\bpublic\s+event\s/gu,
    theirs: /\b(?:IEventBus|EventBus|ISignal|SignalBus)\b|\.(?:Publish|Subscribe)\s*[(<]/u,
    instead: "Strada.Core.Communication (Runtime/Communication) — 11 public types, none used",
    floor: 5,
  },
  {
    // A system that declares [Inject] and falls back to
    // GameBootstrapper.Services.TryGet whenever a field is null masks a wiring
    // question: if the services are registered the fallback is never needed,
    // and a green suite over a workaround is still green.
    // Upstream SystemRunner does not inject systems, though: it hands one only
    // EntityManager and EventBus, so the advice says when [Inject] is filled.
    what: "service-locator lookups beside [Inject]",
    mine: /GameBootstrapper\.Services\s*\??\.\s*TryGet|GameBootstrapper\.Services\s*\??\.\s*Get\b/gu,
    theirs: /$^/u,
    instead:
      "the container that already holds them — a controller or service takes them as constructor " +
      "parameters. A system gets only EntityManager and EventBus from SystemRunner unless its type is " +
      "registered in the container, and newer Core fills its [Inject] fields only when that registration " +
      "is builder.RegisterService<T>(). unity_playmode_verify prints one [StradaWiring] line per system " +
      "saying whether each dependency is registered. Read that before adding a fallback",
    floor: 2,
  },
  {
    what: "UnityEngine.Debug.Log",
    mine: /\bDebug\.Log(?:Warning|Error)?\s*\(/gu,
    theirs: /\bStradaLog\b/u,
    instead: "Strada.Core.Logging.StradaLog (Runtime/Logging) — levels and LogModule categories",
    floor: 10,
  },
];

/** A service the project declares and nothing registers with the container. */
export interface UnregisteredService {
  /** The class's name, as declared. */
  readonly name: string;
  /** Its path, relative to the project. */
  readonly file: string;
}

/**
 * A non-abstract `…Service` class the project declares, which no file
 * registers with Strada.Core's container.
 *
 * Measured 2026-10-14 on a live proof run: 8 of the game's 9 services were
 * never registered. Every one compiled, the suite was green, and the gates
 * that read module shape saw a complete module — because a service is
 * registered in a ModuleConfig's Configure, and no rule asked whether the
 * service that was just written appears there. An unregistered service is
 * reachable only by `new` or by a hunt through the scene, which is the drift
 * the framework exists to prevent.
 *
 * What counts as registered: a `RegisterService<…>` (or
 * `RegisterController<…>`) type argument naming it anywhere in the project's
 * own code, or an `[AutoRegister…]` attribute on the declaration — the two
 * routes Strada.Core actually resolves. Nothing is inferred from a name.
 *
 * Only files the agent authored are judged (`authored`), so an imported
 * package's services are not the project's problem, and test code is skipped.
 */
export function assessUnregisteredServices(
  projectPath: string,
  io: SceneWiringIo = defaultIo,
  authored?: (file: string) => boolean,
): UnregisteredService[] {
  const assets = join(projectPath, "Assets");
  if (!io.exists(assets)) return [];
  const scripts = io.listFiles(assets, isSourceFile).filter((f) => isSourceFile(f));
  if (scripts.length === 0) return [];
  // A TRUNCATED WALK CANNOT ACCUSE. At the budget the listing may have
  // stopped before the file that holds the registration, and this rule's
  // whole claim is that no file registers the service (the same reasoning as
  // the asset census, audited 2026-09-02).
  if (scripts.length >= SCENE_WALK_BUDGET) return [];

  const declared: Array<{ name: string; file: string }> = [];
  const registered = new Set<string>();
  for (const script of scripts) {
    let text: string;
    try {
      text = stripCsComments(io.readFile(script), { blankStrings: true });
    } catch {
      // Unreadable file: absence of evidence. It may hold the registration.
      return [];
    }
    for (const m of text.matchAll(REGISTERED_TYPE_ARG_RE)) {
      for (const arg of m[1]!.split(",")) {
        const last = arg.trim().replace(/^global::/u, "").split(".").pop();
        if (last !== undefined && last !== "") registered.add(last);
      }
    }
    // A test may hold a registration (a fixture bootstrapper), so tests are
    // read for registrations and only skipped as DECLARATION sites.
    if (/[/\\]Tests?[/\\]/u.test(script)) continue;
    if (authored !== undefined && !authored(script)) continue;
    for (const m of text.matchAll(SERVICE_DECL_RE)) {
      if (/\babstract\b/u.test(m[1] ?? "")) continue;
      if (AUTO_REGISTER_RE.test(m[1] ?? "")) continue;
      // Forward slashes, on every platform: Windows' relative() answers with
      // backslashes and the path is read by people and matched by tests
      // (CI windows-test, 2026-10-14).
      declared.push({ name: m[2]!, file: (relative(projectPath, script) || script).replace(/\\/gu, "/") });
    }
  }
  return declared.filter((d) => !registered.has(d.name));
}

/**
 * A class whose name ends in `Service`, with whatever modifiers and
 * attributes precede it on the same declaration — the prefix is what says
 * `abstract` or `[AutoRegister]`, and both decide whether the class needs a
 * registration at all.
 */
const SERVICE_DECL_RE = /((?:\[[^\]]*\]\s*|(?:public|internal|private|protected|sealed|abstract|static|partial)\s+)*)class\s+(\w*Service)\b/gu;

/** The type arguments of a registration call: `RegisterService<IFoo, Foo>()`. */
const REGISTERED_TYPE_ARG_RE = /\bRegister(?:Service|Controller)\s*<([^>]+)>/gu;

/** The attribute that registers a service without a Configure line. */
const AUTO_REGISTER_RE = /\[\s*(?:[\w.]+\.)?AutoRegister\w*/u;

/**
 * Where the project wrote its own version of something the framework ships.
 *
 * Not "which subsystems went unused" — a game owes nobody a state machine.
 * This counts only reimplementation: the project built the thing AND never
 * touched the one that was already there (for example, many public events
 * and no EventBus use).
 *
 * `authored`, when given, limits what counts as the project's OWN version to
 * the files this run wrote: a vendor pack's or a legacy file's Debug.Log calls
 * accused every later run of reimplementing logging, and no edit the run was
 * asked to make could clear it (audited 2026-09-24). Whether the framework's
 * version is used is still read across the project's own code.
 */
export function assessFrameworkBypass(
  projectPath: string,
  io: SceneWiringIo = defaultIo,
  authored?: (file: string) => boolean,
): FrameworkBypass[] {
  const assets = join(projectPath, "Assets");
  if (!io.exists(assets)) return [];

  // Same shape as assessViewLayer: budget the .cs files, do not slice a full
  // listing (audited 2026-09-02).
  const scripts = io
    .listFiles(assets, isSourceFile)
    .filter((f) => isSourceFile(f) && !/[/\\]Tests?[/\\]/u.test(f));
  if (scripts.length === 0) return [];

  // Comments and string contents are not code: a comment naming StradaLog
  // cleared the logging rule, and a commented-out Debug.Log counted against it.
  const sources: Array<{ text: string; mine: boolean }> = [];
  for (const script of scripts) {
    try {
      sources.push({
        text: stripCsComments(io.readFile(script), { blankStrings: true }),
        mine: authored === undefined || authored(script),
      });
    } catch {
      // Unreadable file: absence of evidence, not evidence of bypass.
    }
  }

  const out: FrameworkBypass[] = [];
  for (const rule of BYPASS_RULES) {
    if (sources.some(({ text }) => rule.theirs.test(text))) continue;
    const count = sources.reduce(
      (total, { text, mine }) => total + (mine ? (text.match(rule.mine)?.length ?? 0) : 0),
      0,
    );
    if (count >= rule.floor) out.push({ what: rule.what, count, instead: rule.instead });
  }
  return out;
}
