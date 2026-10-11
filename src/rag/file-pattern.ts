import { isAbsolute, relative, resolve, sep } from "node:path";
// @ts-ignore -- picomatch is a direct dependency (package.json) but ships no bundled types
import picomatch from "picomatch";

/**
 * SearchOptions.filePattern as a predicate over an indexed file path.
 *
 * The pattern is a glob over the path relative to a project root, with forward
 * slashes — the form grep_search and glob_search take — and a pattern naming a
 * directory also takes the files under it. It used to be tested as a literal
 * substring of the path relative to the daemon's cwd, so every glob, the
 * code_search schema's own example included, dropped every hit (audit tools#4).
 *
 * A path is in scope when it lies under one of `roots` and its path relative
 * to that root matches; a path under none of them never matches.
 */
export function createFilePatternFilter(
  pattern: string,
  roots: readonly string[],
): (filePath: string) => boolean {
  const directory = pattern.replace(/\/+$/, "") || pattern;
  const isMatch = picomatch([directory, `${directory}/**`]) as (input: string) => boolean;
  const resolvedRoots = [...new Set(roots.map((root) => resolve(root)))];
  return (filePath) =>
    resolvedRoots.some((root) => {
      const rel = relative(root, resolve(root, filePath));
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
      return isMatch(sep === "/" ? rel : rel.split(sep).join("/"));
    });
}
