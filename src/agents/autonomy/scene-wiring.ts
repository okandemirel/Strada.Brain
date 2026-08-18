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
  for (const cls of configClasses) {
    const name = basename(cls, ".cs");
    if (!assetNames.has(name)) {
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
