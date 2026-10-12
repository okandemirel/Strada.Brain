import { posix } from "node:path";

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
