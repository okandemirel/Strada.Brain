/**
 * What the runtime writes for itself — `.strada`, `.strada-memory`,
 * `.strada-update.lock` — as a test run finds it in the checkout it stands in.
 * vitest.worker-setup.ts fails a test file that leaves a new one there.
 * docs/contracts/clean-checkout.md
 */
import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const RUNTIME_ENTRY = /^\.strada/;

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Every runtime entry directly in `dir`, and everything inside one to any
 * depth, as `/`-separated paths relative to `dir`. An entry that vanishes
 * while it is listed (a lock released, a test's own cleanup) is left out;
 * a `dir` that does not exist has none.
 */
export function runtimeEntriesIn(dir: string): Set<string> {
  const entries = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (isNotFound(error)) return entries;
    throw error;
  }
  for (const name of names.filter((n) => RUNTIME_ENTRY.test(n))) {
    entries.add(name);
    try {
      if (!statSync(join(dir, name)).isDirectory()) continue;
      for (const nested of readdirSync(join(dir, name), { recursive: true })) {
        entries.add(`${name}/${String(nested).split(sep).join("/")}`);
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return entries;
}

/**
 * The runtime entries in `dir` now that `before` did not have, deepest only:
 * a new `.strada-memory` holding a new `probe.db` is `.strada-memory/probe.db`.
 * Empty exactly when nothing is new.
 */
export function newRuntimeEntries(dir: string, before: ReadonlySet<string>): string[] {
  const added = [...runtimeEntriesIn(dir)].filter((entry) => !before.has(entry));
  return added.filter((entry) => !added.some((other) => other.startsWith(`${entry}/`))).sort();
}

/** Why a test file fails when it ends with `leaked` (absolute paths) in the checkout. */
export function leakedEntriesMessage(leaked: readonly string[]): string {
  return (
    `This test file left ${leaked.join(", ")} in the checkout it runs from; .gitignore hides them from git status. ` +
    "A relative default (.strada-memory/…) resolves against the working directory, and a vault or lock built " +
    "from the install root lands beside the source: give the test a path inside its own temp folder. " +
    "Measured: runtime entries that appeared between this file's setup and its end. Not measured: an entry " +
    "that was already there (delete it after the fix, or this check stays blind to it), and which file wrote " +
    "it — files in other workers share this checkout, so if this one does not write it, run it alone to " +
    "confirm. docs/contracts/clean-checkout.md"
  );
}
