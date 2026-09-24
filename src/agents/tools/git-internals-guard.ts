import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Writes and deletes into git's own files are refused by the file tools.
 *
 * validatePath blocks only `.git/config` and `.git/credentials`, so hooks,
 * HEAD, the index, refs and `.git/modules/*` were writable and deletable. A
 * hook is a program git runs on the next commit (git_commit), which puts it
 * outside everything the shell review sees. Reads stay allowed; git state
 * changes go through the git_* tools.
 */
export const GIT_INTERNALS_ERROR =
  "Error: writing to or deleting git's internal files (.git/) is not permitted through file tools; " +
  "use the git_* tools to change repository state.";

/**
 * The path with every EXISTING component resolved through symlinks: the
 * deepest existing ancestor is realpath'd and the missing tail re-joined, so
 * a symlinked directory cannot hide where a new file would land.
 */
async function canonical(fullPath: string): Promise<string> {
  const tail: string[] = [];
  let current = resolve(fullPath);
  for (;;) {
    try {
      return join(await realpath(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(fullPath);
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Does `fullPath` (a path validatePath accepted) name a `.git` entry of the
 * project, or anything inside one? Checked on the resolved path relative to
 * the project root, so the project's own location never matters.
 */
export async function isGitInternalsPath(projectPath: string, fullPath: string): Promise<boolean> {
  const target = await canonical(fullPath);
  const roots = [resolve(projectPath), await canonical(projectPath)];
  for (const root of roots) {
    const rel = relative(root, target);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    return rel.split(/[\\/]/).some((segment) => segment.toLowerCase() === ".git");
  }
  return false;
}
