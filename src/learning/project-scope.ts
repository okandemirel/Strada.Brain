/**
 * Leaf module: pure helpers for project-scope fingerprint comparison.
 *
 * Kept separate so callers (e.g. the dashboard layer) can import this
 * lightweight utility without pulling in the full RuntimeArtifactManager
 * module graph.
 */

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
