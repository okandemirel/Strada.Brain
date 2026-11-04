/**
 * Is this path inside that root? The one place the question is answered.
 *
 * Contract: docs/contracts/path-containment.md. Before this module the repo
 * held the same check in at least 43 files, written five different ways, and
 * the copies disagreed: string-prefix against `relative()`, `startsWith("..")`
 * (which calls a child named `..cache` an escape) against a segment test, a
 * root that counted as inside for some callers and outside for others, and
 * `root + sep` that broke on a filesystem root. The /var vs /private/var
 * defects in the vault registry (74db22a1) and the path guard (5fb0d54c)
 * came from the same family.
 *
 * Both functions are LEXICAL: they compare the strings they are given. When a
 * symlink may sit between the two (a temp dir on macOS, a Windows 8.3 short
 * name, a project reached through a link), bring both sides into the same
 * spelling first — realpath both, or neither. Mixing one real path with one
 * typed path is the bug, not the comparison.
 */

import * as nodePath from "node:path";

/** The two path operations the answer depends on; pass `path.win32`/`path.posix` to test another platform. */
export type PathRules = Pick<typeof nodePath, "isAbsolute" | "relative">;

/** Path segments, split on either separator — Windows accepts both. */
function firstSegment(value: string): string {
  return value.split(/[\\/]+/)[0] ?? "";
}

/** The step from `root` to `candidate`, or null when it climbs out or changes drive. */
function stepWithin(root: string, candidate: string, rules: PathRules): string | null {
  const step = rules.relative(root, candidate);
  if (rules.isAbsolute(step) || firstSegment(step) === "..") return null;
  return step;
}

/** `candidate` is `root` itself or anywhere below it. */
export function isAtOrInside(root: string, candidate: string, rules: PathRules = nodePath): boolean {
  return stepWithin(root, candidate, rules) !== null;
}

/** `candidate` is below `root` — `root` itself does not count. */
export function isStrictlyInside(root: string, candidate: string, rules: PathRules = nodePath): boolean {
  const step = stepWithin(root, candidate, rules);
  return step !== null && step !== "";
}
