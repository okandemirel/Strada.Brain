/**
 * Fixtures that must never enter the public repository: a private run's own
 * export, the names of a project built with Strada.Brain, its design
 * documents. They live in the gitignored tests/fixtures/local/ directory, and
 * a test that reads one is skipped, saying why, on a checkout that has none.
 *
 * A worktree carries no ignored files, so a name missing from the checkout
 * under test is also looked up in the main checkout the worktree was made
 * from: the fixtures put there once reach every worktree of that clone.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const LOCAL_FIXTURES_DIR = join("tests", "fixtures", "local");

/** The main checkout's root when REPO_ROOT is a linked worktree of it; undefined otherwise. */
function mainCheckoutRoot(): string | undefined {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (basename(common) !== ".git") return undefined;
    const root = dirname(common);
    return resolve(root) === resolve(REPO_ROOT) ? undefined : root;
  } catch {
    return undefined;
  }
}

/** The absolute path of tests/fixtures/local/<name> in this checkout or its main checkout, if either holds it. */
export function localFixturePath(name: string): string | undefined {
  for (const root of [REPO_ROOT, mainCheckoutRoot()]) {
    if (root === undefined) continue;
    const path = join(root, LOCAL_FIXTURES_DIR, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/** Why a test that needs tests/fixtures/local/<name> did not run. */
export function missingLocalFixture(name: string, what: string): string {
  return `skipped: no ${LOCAL_FIXTURES_DIR}/${name} (${what}; gitignored, never committed)`;
}
