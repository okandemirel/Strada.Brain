/**
 * Leaf module: pure helpers for project-scope fingerprint comparison.
 *
 * Kept separate so callers (e.g. the dashboard layer) can import this
 * lightweight utility without pulling in the full RuntimeArtifactManager
 * module graph.
 */

/**
 * Returns true when `artifactFingerprint` and `runtimeFingerprint` refer to
 * the same project scope (or one is a prefix of the other).
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
  return left === right || left.startsWith(right) || right.startsWith(left);
}
