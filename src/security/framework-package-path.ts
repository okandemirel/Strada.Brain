import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { posix, relative, resolve } from "node:path";

/**
 * Where a Unity project keeps a Strada framework package: the submodule
 * folder the installers use, an embedded package directly under Packages/,
 * and the Assets/ install target Strada.MCP offers. The game's own code never
 * lives there.
 */
const FRAMEWORK_PACKAGE_ROOT = /^(?:packages\/submodules\/strada\.[^/]+|packages\/(?:com\.)?strada\.[^/]+|assets\/strada\.mcp(?:\.meta)?)(?:\/|$)/i;

/**
 * Whether a project-relative path is, or lies inside, a Strada framework
 * package. Separators, `./` and letter case do not change the answer (APFS
 * and NTFS are case-insensitive by default); a path that leaves the project
 * is not one.
 */
export function isFrameworkPackagePath(projectRelative: string): boolean {
  const spelled = posix.normalize(projectRelative.replace(/\\/g, "/"));
  if (spelled === "." || spelled.startsWith("../") || spelled === ".." || spelled.startsWith("/")) return false;
  return FRAMEWORK_PACKAGE_ROOT.test(spelled.replace(/^\.\//, ""));
}

/**
 * The refusal for a write into a framework package, naming the package.
 *
 * The vendored copy is upstream's code at a recorded commit. A run that
 * edited it, or left its reports in it, changed what the project compiles
 * against without a trace upstream, and the framework vaults then served the
 * reports back as if they were the framework (measured: 53 reports inside a
 * vendored Strada.Core, 79 inside a vendored Strada.MCP).
 */
export function frameworkPackageWriteRefusal(projectRelative: string): string | undefined {
  if (!isFrameworkPackagePath(projectRelative)) return undefined;
  const spelled = posix.normalize(projectRelative.replace(/\\/g, "/")).replace(/^\.\//, "");
  const pkg = spelled.split("/").find((segment) => /^(?:com\.)?strada\./i.test(segment)) ?? "a Strada package";
  return (
    `${spelled} is inside the ${pkg.replace(/\.meta$/i, "")} framework package, which agents do not write: it is ` +
    "upstream's code, vendored at a recorded commit. Read it freely; put the change in the game's own code " +
    "(Assets/...), and report what the framework is missing instead of patching it."
  );
}

/** Whether a project-relative path is the project's Packages/manifest.json, by any spelling. */
export function isUnityManifestPath(projectRelative: string): boolean {
  const spelled = posix.normalize(projectRelative.replace(/\\/g, "/")).replace(/^\.\//, "");
  return /^packages\/manifest\.json$/i.test(spelled);
}

/** `"com.strada.core": "file:..."` and the like: a Strada package's dependency line. */
const STRADA_DEPENDENCY_LINE = /"((?:com\.)?strada\.[^"\\/]+)"\s*:\s*"([^"\\]*)"/gi;

/**
 * The Strada package lines of a manifest's text, by lower-cased name. Read
 * as text, not parsed, so a manifest a write left unparseable still says
 * which lines it carries.
 */
function stradaManifestLines(manifestText: string | undefined): Map<string, string> {
  const lines = new Map<string, string>();
  for (const match of (manifestText ?? "").matchAll(STRADA_DEPENDENCY_LINE)) {
    lines.set(match[1]!.toLowerCase(), match[2]!);
  }
  return lines;
}

/**
 * The refusal for a change to Packages/manifest.json that adds, repoints or
 * removes a Strada package line; undefined when those lines stay as they were.
 *
 * Installing a Strada package is the dependency installer's job: it adds the
 * package folder and its line together. The folder is refused to agents
 * (above), so a line an agent adds points Unity at a package that never lands,
 * and Unity then fails to resolve every package of the project; a line it
 * repoints or drops changes what the game compiles against.
 */
export function stradaManifestChangeRefusal(before: string | undefined, after: string | undefined): string | undefined {
  const was = stradaManifestLines(before);
  const now = stradaManifestLines(after);
  const changed = [...new Set([...was.keys(), ...now.keys()])].filter((name) => was.get(name) !== now.get(name)).sort();
  if (changed.length === 0) return undefined;
  const what = changed
    .map((name) => (!was.has(name) ? `adds "${name}"` : !now.has(name) ? `removes "${name}"` : `repoints "${name}"`))
    .join(", ");
  return (
    `Packages/manifest.json: this change ${what}, and agents do not change the Strada package lines. ` +
    "Strada's dependency installer adds a Strada package and its manifest line together, when the operator " +
    "allows it; a line on its own points Unity at a package that is not there, and the project stops " +
    "resolving its packages. Keep those lines as they are; if the task needs a Strada package that is not " +
    "installed, say so in your result so the operator can install it."
  );
}

/**
 * Whether `fullPath` (validatePath's real path) is the project's manifest,
 * by the spelled or the real form of the project root.
 */
export function isProjectManifest(projectRoot: string, fullPath: string): boolean {
  const roots = [resolve(projectRoot)];
  try {
    roots.push(realpathSync.native(projectRoot));
  } catch {
    // A root that cannot be resolved is judged in its spelled form.
  }
  return roots.some((root) => isUnityManifestPath(relative(root, fullPath)));
}

/**
 * The same refusal for a file tool that leaves `after` at `fullPath`
 * (undefined for a delete) when that is the project's manifest. The current
 * text is read unless the caller already holds it.
 */
export async function manifestWriteRefusal(
  projectRoot: string,
  fullPath: string,
  after: string | undefined,
  before?: string,
): Promise<string | undefined> {
  if (!isProjectManifest(projectRoot, fullPath)) return undefined;
  const current = before ?? (await readFile(fullPath, "utf8").catch(() => undefined));
  return stradaManifestChangeRefusal(current, after);
}
