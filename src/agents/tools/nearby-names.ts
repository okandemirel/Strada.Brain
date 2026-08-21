import { readdir } from "node:fs/promises";
import { basename as pathBasename, dirname as pathDirname } from "node:path";

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
