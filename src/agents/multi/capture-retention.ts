/**
 * Retention for capture output under <project>/Recordings/.
 *
 * Every PlayMode capture writes a directory of frames into the lease's
 * Recordings/, and every workspace commit copies it into the project. Nothing
 * ever removed one. Measured 2026-09-07: 1.2 GB, 32,760 frames, 441 entries,
 * growing ~250 MB a day — every lease seed logged "8705 uncommitted paths,
 * seeded 2000", every "newest frame" walk ran into its budget, and the
 * "does it look like the GDD" judgment once picked a frame from an earlier
 * run.
 *
 * Policy: keep the newest KEEP top-level entries (by mtime) and delete the
 * rest. Only Recordings/ — captures are the system's own output, never the
 * user's files — and what was removed is reported, never silent.
 */

import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CAPTURE_ENTRIES_TO_KEEP = 25;

export interface CaptureRetentionResult {
  /** Top-level Recordings/ entries deleted. */
  readonly removed: number;
  /** Bytes freed (as walked before deletion). */
  readonly bytes: number;
  /** Top-level entries left in place. */
  readonly kept: number;
  /** Entries without the lease marker — the user's own; never pruned. */
  readonly unmarked: number;
}

function sizeOf(path: string): number {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    const stack = [path];
    let visited = 0;
    while (stack.length > 0 && visited < 50_000) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        visited++;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else {
          try {
            total += statSync(full).size;
          } catch {
            /* vanished */
          }
        }
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/** Delete all but the newest `keep` top-level entries of <projectRoot>/Recordings. */
/**
 * The marker a lease commit drops into every Recordings/ entry IT wrote. Only
 * marked entries are ever pruned: Recordings/ is also Unity Recorder's default
 * output folder, and the first version of this deleted the user's own takes on
 * every commit, including a commit that wrote nothing (review 2026-09-07).
 */
export const CAPTURE_MARKER_FILE = ".strada-capture";

export function markCaptureEntry(projectRoot: string, entryName: string): void {
  const dir = join(projectRoot, "Recordings", entryName);
  try {
    if (!statSync(dir).isDirectory()) return;
    writeFileSync(join(dir, CAPTURE_MARKER_FILE), "written by a Strada.Brain lease commit; retention may prune this entry\n");
  } catch {
    /* an unmarkable entry is simply never pruned */
  }
}

export function pruneCaptureEntries(projectRoot: string, keep = CAPTURE_ENTRIES_TO_KEEP): CaptureRetentionResult {
  const root = join(projectRoot, "Recordings");
  if (!existsSync(root)) return { removed: 0, bytes: 0, kept: 0, unmarked: 0 };
  const entries: Array<{ path: string; mtime: number }> = [];
  let unmarked = 0;
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    try {
      if (!existsSync(join(full, CAPTURE_MARKER_FILE))) {
        unmarked++;
        continue;
      }
      entries.push({ path: full, mtime: statSync(full).mtimeMs });
    } catch {
      /* vanished */
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  const doomed = entries.slice(keep);
  let bytes = 0;
  let removed = 0;
  for (const entry of doomed) {
    bytes += sizeOf(entry.path);
    try {
      rmSync(entry.path, { recursive: true, force: true });
      removed++;
    } catch {
      /* reported as kept */
    }
  }
  return { removed, bytes, kept: entries.length - removed, unmarked };
}
