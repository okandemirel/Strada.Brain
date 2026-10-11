/**
 * Leaf module: pure helpers for project-scope fingerprint comparison.
 *
 * Kept separate so callers (e.g. the dashboard layer) can import this
 * lightweight utility without pulling in the full RuntimeArtifactManager
 * module graph.
 */

/**
 * The scope fingerprint of a project root: "root" and the path's folders,
 * lowercased and space-separated.
 *
 * Only a path separator may become a space, because a space is where
 * {@link isScopePrefix} lets one scope end and a child begin. Punctuation
 * inside a folder name becomes "_", a word character: folding "-", "_", "."
 * and spaces into the same space as "/" made `/work/Tower` the parent of its
 * sibling `/work/Tower-Defense`, so guidance learned in one project reached the
 * other. The run's fingerprint (buildProjectWorldMemorySection) opens with this
 * same string, so both sides fold a name the same way.
 */
export function createProjectScopeFingerprint(projectPath: string | null | undefined): string | undefined {
  const trimmed = projectPath?.trim();
  if (!trimmed) {
    return undefined;
  }
  const folders = trimmed
    .toLowerCase()
    .split(/[\\/]+/)
    .map((folder) => folder.replace(/[^\p{L}\p{N}]+/gu, "_"))
    .filter((folder) => folder.length > 0);
  return ["root", ...folders].join(" ").slice(0, 220);
}

/**
 * Returns true when `artifactFingerprint` and `runtimeFingerprint` refer to
 * the same project scope (or one is a parent scope of the other).
 *
 * Both arguments are treated as trimmed strings; absent/empty values → false.
 */
export function projectScopeMatches(
  artifactFingerprint: string | null | undefined,
  runtimeFingerprint: string | null | undefined,
): boolean {
  const left = artifactFingerprint?.trim();
  const right = runtimeFingerprint?.trim();
  if (!left || !right) {
    return false;
  }
  return left === right || isScopePrefix(right, left) || isScopePrefix(left, right);
}

/**
 * `prefix` opens `value` and ends on a word boundary (LRN-16). A raw string
 * prefix made `/work/Tower` a parent of `/work/TowerDefense`, so guidance
 * learned in one project passed the scope gate in its sibling.
 */
function isScopePrefix(prefix: string, value: string): boolean {
  if (!value.startsWith(prefix)) return false;
  const wordChar = /[\p{L}\p{N}_]/u;
  // Either side of the cut must be a separator ("/a/" opens "/a/b").
  return !wordChar.test(prefix.charAt(prefix.length - 1)) || !wordChar.test(value.charAt(prefix.length));
}
