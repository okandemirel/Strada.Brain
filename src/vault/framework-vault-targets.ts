import type { StradaDepsStatus } from "../config/strada-deps.js";

export interface FrameworkVaultTarget {
  readonly name: string;
  readonly rootPath: string;
  /**
   * `installed`: the copy the project compiles against. `available`: an
   * upstream checkout beside the install, indexed so its API can be found
   * before the package is installed. Absent for this system's own source.
   */
  readonly state?: "installed" | "available";
  /** Which vault-relative paths the vault indexes; undefined indexes the whole root. */
  readonly includePath?: (relPath: string) => boolean;
}

/** Where a Unity package keeps what it is: its code, editor code, docs. */
const FRAMEWORK_SOURCE_DIRS = ["runtime", "editor", "documentation~"] as const;
/**
 * Never the framework at the package root: build output, scan reports, and
 * the folders runs wrote their own notes into inside the vendored copies.
 * Only there: the same words name real source folders further down
 * (Strada.MCP's src/tools/analysis/ holds ten of its tools).
 */
const FRAMEWORK_EXCLUDED_ROOT_DIRS = new Set([
  "dist", "securityreports", "notes", "docs", "analysis", "plans", "reports",
]);
/**
 * Test assemblies, at any depth: a module keeps them beside its Runtime/
 * (ScreenModule/Tests) as a Unity package does, and Tests/Runtime is not the
 * package's runtime. A test double would rank beside the API it fakes.
 */
const FRAMEWORK_TEST_DIRS = new Set(["tests"]);

/**
 * The scope of a framework vault, judged per path segment so a module
 * package (`ScreenModule/Runtime/...`) keeps its modules one level down.
 * A README is kept anywhere outside an excluded folder.
 */
export function frameworkVaultScope(extraSourceDirs: readonly string[] = []): (relPath: string) => boolean {
  const sources = new Set<string>([...FRAMEWORK_SOURCE_DIRS, ...extraSourceDirs.map((d) => d.toLowerCase())]);
  return (relPath) => {
    const segments = relPath.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".");
    const file = segments.pop()?.toLowerCase();
    if (!file) return false;
    const dirs = segments.map((s) => s.toLowerCase());
    if (dirs.length > 0 && FRAMEWORK_EXCLUDED_ROOT_DIRS.has(dirs[0]!)) return false;
    if (dirs.some((d) => FRAMEWORK_TEST_DIRS.has(d))) return false;
    return file === "readme.md" || dirs.some((d) => sources.has(d));
  };
}

/**
 * The codebases this system is supposed to have mastered.
 *
 * Both boot-time vault registrations were pinned to the Unity project, so the
 * only codebase ever indexed was the project being built. Strada.Core,
 * Strada.Modules, Strada.MCP and Brain itself — the systems every plan is
 * written against — were searchable nowhere. In a live campaign the project
 * had a working vault while the framework repositories had none, and the
 * knowledge that should have come from reading them arrived instead as prose
 * rules typed into a prompt after each incident.
 *
 * A package the project does not have is indexed from its upstream checkout
 * when one was found (WP-1.2): Strada.Modules otherwise had no vault at all.
 *
 * Nothing here reads the disk: callers skip targets they cannot open, so a
 * package with neither an install nor a checkout produces no target.
 */
export function frameworkVaultTargets(
  deps: StradaDepsStatus | undefined,
  brainRoot: string | undefined,
): FrameworkVaultTarget[] {
  const frameworkScope = frameworkVaultScope();
  // Strada.MCP's framework is its TypeScript source as much as its Unity package.
  const mcpScope = frameworkVaultScope(["src"]);
  const installedOrAvailable = (
    installed: boolean | undefined,
    path: string | null | undefined,
    checkout: StradaDepsStatus["coreCheckout"],
  ): [string | null | undefined, FrameworkVaultTarget["state"]] =>
    installed && path ? [path, "installed"] : [checkout?.path, "available"];

  const candidates: Array<[string, string | null | undefined, FrameworkVaultTarget["state"], FrameworkVaultTarget["includePath"]]> = [
    ["Strada.Brain", brainRoot, undefined, undefined],
    ["Strada.Core", ...installedOrAvailable(deps?.coreInstalled, deps?.corePath, deps?.coreCheckout), frameworkScope],
    ["Strada.Modules", ...installedOrAvailable(deps?.modulesInstalled, deps?.modulesPath, deps?.modulesCheckout), frameworkScope],
    ["Strada.MCP", deps?.mcpInstalled ? deps.mcpPath : null, "installed", mcpScope],
  ];

  const seen = new Set<string>();
  const out: FrameworkVaultTarget[] = [];
  for (const [name, path, state, includePath] of candidates) {
    const trimmed = path?.trim();
    if (!trimmed) continue;
    // A submodule copy and its standalone repo can resolve to the same folder;
    // indexing it twice would double the work and split the results.
    const key = trimmed.replace(/\/+$/u, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, rootPath: key, ...(state ? { state } : {}), ...(includePath ? { includePath } : {}) });
  }
  return out;
}
