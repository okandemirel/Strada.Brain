import { readdir } from "node:fs/promises";
import { basename as pathBasename, dirname as pathDirname, join as pathJoin, relative as pathRelative } from "node:path";

/**
 * What is actually in the directory the caller aimed at.
 *
 * Measured on the run of 2026-08-20: the agent wrote
 * docs/PixelFlow_GDD_StructuredSummary.md and then tried three times to read
 * docs/PixelFlow_StructuredBrief.md — its own file, misremembered. "File not
 * found" ends there; the names beside it turn the miss into one correction.
 */
export async function nearbyNames(fullPath: string): Promise<string> {
  try {
    const entries = await readdir(pathDirname(fullPath));
    const wanted = pathBasename(fullPath).toLowerCase();
    // Anything sharing a leading run of characters is a likelier candidate than
    // whatever the directory happens to list first.
    const scored = entries
      .map((name) => ({ name, shared: sharedPrefixLength(name.toLowerCase(), wanted) }))
      .sort((a, b) => b.shared - a.shared)
      .slice(0, 5)
      .map((e) => e.name);
    return scored.length > 0 ? ` — that directory holds: ${scored.join(", ")}` : "";
  } catch {
    // No directory, or unreadable: the plain miss is the whole answer.
    return "";
  }
}

function sharedPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Directories that hold build output or dependencies, not the project's own source. */
const SKIP_DIRECTORIES = new Set([
  "Library", "Temp", "Obj", "obj", "Build", "Builds", "Logs", "node_modules",
  ".git", ".strada-memory", "bin", "dist", "UserSettings",
]);

/** A bound, so a miss inside a large project stays a cheap answer. */
const MAX_DIRECTORIES_SCANNED = 2000;

/**
 * The same filename, somewhere else in the project.
 *
 * Measured 2026-08-21 across one run: of seven file_read misses, six named a
 * file that existed under exactly that name in a different directory —
 * BoardState.cs sought in Scripts/Data and living in Scripts/Models,
 * IInputService.cs sought in Services and living in Interfaces. For those, the
 * neighbouring names are worse than useless: they describe a directory the
 * file was never in.
 */
export async function sameNameElsewhere(
  projectRoot: string,
  fullPath: string,
  limit = 3,
): Promise<string[]> {
  const wanted = pathBasename(fullPath);
  const found: string[] = [];
  const queue: string[] = [projectRoot];
  let scanned = 0;

  while (queue.length > 0 && found.length < limit && scanned < MAX_DIRECTORIES_SCANNED) {
    const dir = queue.shift();
    if (dir === undefined) break;
    scanned++;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // Unreadable directory: not the caller's problem to hear about.
    }
    for (const entry of entries) {
      const child = pathJoin(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) queue.push(child);
      } else if (entry.name === wanted && child !== fullPath) {
        found.push(pathRelative(projectRoot, child));
        if (found.length >= limit) break;
      }
    }
  }
  return found;
}
