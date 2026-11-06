/**
 * What the runtime writes for itself — `.strada`, `.strada-memory`,
 * `.strada-update.lock` — as a test run finds it in the checkout it stands in.
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
