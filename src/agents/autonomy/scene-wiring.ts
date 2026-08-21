import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

/**
 * Whether a run delivered a game or a library.
 *
 * The conformance guard checks the shape of code: a module has a ModuleConfig
 * class, an .asmdef, tests. Every one of those can pass while nothing runs.
 * Measured on a 104-minute run: nine modules, fifty C# files, sixteen test
 * assemblies, all compiling — and zero scenes, zero ScriptableObject assets and
 * no bootstrapper wiring. The run reported success. A developer opening that
 * project finds a library.
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
  listFiles(dir: string): string[];
  readFile(path: string): string;
  exists(path: string): boolean;
}

const defaultIo: SceneWiringIo = {
  listFiles: (dir) => walk(dir),
  readFile: (p) => readFileSync(p, "utf-8"),
  exists: (p) => existsSync(p),
};

function walk(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

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
 * Measured 2026-08-20: a scene assembled by unity_scene_build, verified on
 * disk, and passing its play-mode boot test was reported unassembled — because
 * the assets are named UIModule.asset while the class is UIModuleConfig, and
 * the check compared names. A correctly built game accused of being a library
 * sends the agent back to rebuild what it had already got right.
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

  const files = io.listFiles(assetsRoot);
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
 * Measured 2026-08-21 on a delivered project: 85 C# files, 25 prefabs, 44
 * passing play-mode tests — and zero MonoBehaviours, zero uses of Strada.Core's
 * View, EntityView, EntityMediator or ViewRegistry, and one GameObject in the
 * only scene. Every service and system was correct and nothing could be seen.
 * The tests passed because they call services directly and never go through a
 * scene.
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

  const files = io.listFiles(assets).slice(0, 4000);
  const prefabs = files.filter((f) => f.endsWith(".prefab"));
  const scripts = files.filter((f) => f.endsWith(".cs") && !/[/\\]Tests?[/\\]/u.test(f));
  if (prefabs.length === 0 || scripts.length === 0) return null;

  let viewScripts = 0;
  for (const script of scripts) {
    let text: string;
    try {
      text = io.readFile(script);
    } catch {
      continue;
    }
    if (VIEW_MARKERS.some((marker) => text.includes(marker))) viewScripts++;
  }

  return {
    hasViews: viewScripts > 0,
    prefabCount: prefabs.length,
    scriptCount: scripts.length,
  };
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
    what: "UnityEngine.Debug.Log",
    mine: /\bDebug\.Log(?:Warning|Error)?\s*\(/gu,
    theirs: /\bStradaLog\b/u,
    instead: "Strada.Core.Logging.StradaLog (Runtime/Logging) — levels and LogModule categories",
    floor: 10,
  },
];

/**
 * Where the project wrote its own version of something the framework ships.
 *
 * Not "which subsystems went unused" — a game owes nobody a state machine.
 * This counts only reimplementation: the project built the thing AND never
 * touched the one that was already there.
 *
 * Measured 2026-08-21 on a delivered project: 22 hand-rolled public events
 * against 0 uses of Communication's 11 types, and 37 Debug.Log calls against 0
 * uses of Logging's 10. Six of Strada.Core's 194 public types were used at all.
 * The project inherited SystemBase to get a tick, took [Inject], registered a
 * ModuleConfig, and wrote a plain C# game inside the shell.
 */
export function assessFrameworkBypass(
  projectPath: string,
  io: SceneWiringIo = defaultIo,
): FrameworkBypass[] {
  const assets = join(projectPath, "Assets");
  if (!io.exists(assets)) return [];

  const scripts = io
    .listFiles(assets)
    .slice(0, 4000)
    .filter((f) => f.endsWith(".cs") && !/[/\\]Tests?[/\\]/u.test(f));
  if (scripts.length === 0) return [];

  const sources: string[] = [];
  for (const script of scripts) {
    try {
      sources.push(io.readFile(script));
    } catch {
      // Unreadable file: absence of evidence, not evidence of bypass.
    }
  }

  const out: FrameworkBypass[] = [];
  for (const rule of BYPASS_RULES) {
    if (sources.some((text) => rule.theirs.test(text))) continue;
    const count = sources.reduce(
      (total, text) => total + (text.match(rule.mine)?.length ?? 0),
      0,
    );
    if (count >= rule.floor) out.push({ what: rule.what, count, instead: rule.instead });
  }
  return out;
}
