/**
 * WHAT THIS PROJECT ALREADY HAS, measured from the tree itself.
 *
 * M6 of the drift audit (2026-10-11): every campaign plans as if the project
 * were empty, so each one adds another implementation of work already there —
 * three parallel simulations in one measured game. The planner had no
 * inventory because nothing ever built one; the framework note it gets
 * describes Strada, not the project.
 *
 * Measured only, never inferred: a module is a directory under Assets that
 * holds a ModuleConfig, a service is a declared `…Service` class, a scene is
 * a .unity file, and a scene is shipped when EditorBuildSettings enables it.
 * Nothing here says whether any of it is GOOD — it says what is there, so a
 * plan can extend it instead of growing a rival beside it.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { isVendorPath } from "./csharp-source.js";
import { type SceneWiringIo } from "./scene-wiring.js";
import { walkFilesForInventory } from "./scene-wiring.js";

export interface ProjectInventory {
  /** Module directories with a ModuleConfig, by name. */
  readonly modules: readonly string[];
  /** `…Service` classes the project declares, by name. */
  readonly services: readonly string[];
  /** Scene paths, project-relative, POSIX. */
  readonly scenes: readonly string[];
  /** The scenes EditorBuildSettings enables, project-relative, POSIX. */
  readonly shippedScenes: readonly string[];
  /** Game .cs files under Assets, vendored code excluded. */
  readonly scriptCount: number;
  /** True when Assets exists at all. */
  readonly measured: boolean;
}

const INVENTORY_BUDGET = 4_000;
const posix = (p: string): string => p.replace(/\\/gu, "/");

const defaultIo: SceneWiringIo = {
  listFiles: (dir, match) => walkFilesForInventory(dir, INVENTORY_BUDGET, match),
  readFile: (p) => readFileSync(p, "utf-8"),
  exists: (p) => existsSync(p),
};

/** The project's own surface, as files. */
export function readProjectInventory(projectRoot: string, io: SceneWiringIo = defaultIo): ProjectInventory {
  const assets = join(projectRoot, "Assets");
  if (!io.exists(assets)) {
    return { modules: [], services: [], scenes: [], shippedScenes: [], scriptCount: 0, measured: false };
  }
  const files = io.listFiles(assets, (f) => f.endsWith(".cs") || f.endsWith(".unity"));
  const modules = new Set<string>();
  const services = new Set<string>();
  const scenes: string[] = [];
  let scriptCount = 0;
  for (const file of files) {
    if (file.endsWith(".unity")) {
      scenes.push(posix(relative(projectRoot, file)));
      continue;
    }
    if (isVendorPath(file)) continue;
    scriptCount += 1;
    let text: string;
    try {
      text = io.readFile(file);
    } catch {
      continue;
    }
    if (/\bclass\s+\w+\s*:\s*(?:[\w.]+\.)?\w*ModuleConfig\b/u.test(text) || /ModuleConfig\b/u.test(basename(file))) {
      const moduleDir = moduleNameOf(projectRoot, file);
      if (moduleDir !== undefined) modules.add(moduleDir);
    }
    for (const m of text.matchAll(/\bclass\s+(\w*Service)\b/gu)) services.add(m[1]!);
  }
  return {
    modules: [...modules].sort(),
    services: [...services].sort(),
    scenes: scenes.sort(),
    shippedScenes: readShippedScenes(projectRoot, io),
    scriptCount,
    measured: true,
  };
}

/** `Assets/Modules/<Name>/…` → `<Name>`; a config outside a Modules folder names its own directory. */
function moduleNameOf(projectRoot: string, file: string): string | undefined {
  const rel = posix(relative(projectRoot, file));
  const inModules = /(?:^|\/)Modules\/([^/]+)\//u.exec(rel);
  if (inModules) return inModules[1]!;
  const dir = basename(dirname(file));
  return dir === "" || dir === "Assets" ? undefined : dir;
}

/** The scenes EditorBuildSettings marks enabled, in build order. */
function readShippedScenes(projectRoot: string, io: SceneWiringIo): string[] {
  const settings = join(projectRoot, "ProjectSettings", "EditorBuildSettings.asset");
  if (!io.exists(settings)) return [];
  let text: string;
  try {
    text = io.readFile(settings);
  } catch {
    return [];
  }
  const out: string[] = [];
  const entries = text.split(/-\s+enabled:/u).slice(1);
  for (const entry of entries) {
    if (!/^\s*1\b/u.test(entry)) continue;
    const path = /\n\s*path:\s*(\S+)/u.exec(entry)?.[1];
    if (path !== undefined && path !== "") out.push(posix(path));
  }
  return out;
}

/**
 * The inventory as the sentence a planner reads, or null when there is
 * nothing to say (no Assets, or an empty project — where a plan that builds
 * from scratch is the right plan and a note would only add noise).
 */
export function describeProjectInventory(projectRoot: string, io: SceneWiringIo = defaultIo): string | null {
  const inv = readProjectInventory(projectRoot, io);
  if (!inv.measured) return null;
  if (inv.modules.length === 0 && inv.services.length === 0 && inv.scenes.length === 0) return null;
  const list = (items: readonly string[], cap = 12): string =>
    items.length === 0
      ? "none"
      : items.slice(0, cap).join(", ") + (items.length > cap ? `, …and ${items.length - cap} more` : "");
  return [
    "WHAT THIS PROJECT ALREADY HAS (measured from the tree just now, not claimed):",
    `- modules: ${list(inv.modules)}`,
    `- services: ${list(inv.services)}`,
    `- scenes: ${list(inv.scenes)}${inv.shippedScenes.length > 0 ? ` (the build opens ${inv.shippedScenes[0]!})` : " (none enabled in the build)"}`,
    `- ${inv.scriptCount} game script(s) under Assets`,
    "Plan against this: a requirement that an existing module, service or scene already covers is planned as a" +
      " CHANGE to that file, named in the goal. Adding a second module, service or scene for work one of these" +
      " already does is the defect this note exists to prevent — a measured game carried three parallel" +
      " simulations because each campaign planned as if the project were empty.",
  ].join("\n");
}
