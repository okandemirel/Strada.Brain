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

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const CAPTURE_ENTRIES_TO_KEEP = 25;

export interface CaptureRetentionResult {
  /** Top-level Recordings/ entries deleted. */
  readonly removed: number;
  /** Bytes freed (as walked before deletion). */
  readonly bytes: number;
  /** Top-level entries left in place. */
  readonly kept: number;
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
export function pruneCaptureEntries(projectRoot: string, keep = CAPTURE_ENTRIES_TO_KEEP): CaptureRetentionResult {
  const root = join(projectRoot, "Recordings");
  if (!existsSync(root)) return { removed: 0, bytes: 0, kept: 0 };
  const entries: Array<{ path: string; mtime: number }> = [];
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    try {
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
  return { removed, bytes, kept: entries.length - removed };
}
