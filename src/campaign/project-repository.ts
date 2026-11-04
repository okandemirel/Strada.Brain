/**
 * Does the project have a git repository at all? Answered from the
 * filesystem, before any git process is started.
 *
 * The campaign's repository probes (`rev-parse HEAD`, then
 * `--is-inside-work-tree`) used to ask git first and look for a `.git` only
 * after git had failed. On a project with no repository every probe was
 * therefore two failing process spawns. A delivery round makes dozens of
 * them, and measured on 2026-11-04 the bounce test spent 707 of its 802 git
 * processes this way. That cost ~1 s per 100 spawns on macOS and far more on
 * Windows, where the test ran past its 30 s budget. The probes now consult
 * this first and spawn git only when a repository can exist.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Is there a `.git` (a directory, or a worktree's file) at or above `projectRoot`? */
export function gitAbove(projectRoot: string): boolean {
  for (let at = projectRoot; ; ) {
    if (existsSync(join(at, ".git"))) return true;
    const up = dirname(at);
    if (up === at) return false;
    at = up;
  }
}

/**
 * True only when git CANNOT find a repository for `projectRoot`: no `.git`
 * anywhere at or above it, and no GIT_DIR / GIT_WORK_TREE pointing git
 * somewhere else. Not cached — a setup step may `git init` the project at any
 * time, and the walk costs a few stat calls.
 */
export function certainlyNoRepository(projectRoot: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["GIT_DIR"] || env["GIT_WORK_TREE"]) return false;
  return !gitAbove(projectRoot);
}
