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
  readonly kind:
    | "no-scene"
    | "missing-config-asset"
    | "no-bootstrapper"
    | "unwired-bootstrapper"
    | "dangling-script-reference";
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

/**
 * Prefabs and scenes whose components point at scripts that do not exist.
 *
 * Measured 2026-08-20: an agent hand-wrote twenty-five .prefab files rather
 * than going through unity_scene_build, and every m_Script guid in them was
 * invented — six references, six that resolve to nothing. The YAML parses, the
 * structure is right, the .meta files are there, and Unity loads the lot as
 * "Missing (Mono Script)". Unlike a wrong reference TYPE, which only running
 * the game catches, a guid that is in no .meta file in the project can be
 * caught by reading.
 */
function danglingScriptReferences(
  files: readonly string[],
  io: SceneWiringIo,
): { readonly file: string; readonly count: number }[] {
  const known = new Set<string>();
  for (const meta of files.filter((f) => f.endsWith(".cs.meta"))) {
    let text: string;
    try {
      text = io.readFile(meta);
    } catch {
      continue;
    }
    const guid = /^guid:\s*([0-9a-f]{32})\s*$/m.exec(text)?.[1];
    if (guid) known.add(guid);
  }
  // No .meta files read means this project does not keep them where we can see
  // them — absence of evidence, so accuse nothing.
  if (known.size === 0) return [];

  const out: { file: string; count: number }[] = [];
  for (const asset of files.filter((f) => f.endsWith(".prefab") || f.endsWith(".unity"))) {
    let text: string;
    try {
      text = io.readFile(asset);
    } catch {
      continue;
    }
    const refs = [...text.matchAll(/m_Script:\s*\{fileID:\s*-?\d+,\s*guid:\s*([0-9a-f]{32})/g)];
    const missing = refs.filter((m) => !known.has(m[1]!)).length;
    if (missing > 0) out.push({ file: asset, count: missing });
  }
  return out;
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

  for (const dangling of danglingScriptReferences(files, io)) {
    problems.push({
      kind: "dangling-script-reference",
      detail:
        `${dangling.file} references ${dangling.count} script(s) by a guid no file in this ` +
        `project has — Unity loads those components as Missing (Mono Script). Author prefabs ` +
        `and scenes with unity_scene_build rather than by hand: it writes the guids Unity assigned.`,
    });
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
