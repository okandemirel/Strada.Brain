/**
 * The last PlayMode run as the NUnit file states it.
 *
 * Until 2026-09-10 the delivery gate derived "the suite is green" and
 * "unfiltered" from the verification tool's PROSE with regexes: a run was
 * unfiltered because the sentence contained the word, red because a line
 * matched "N of M tests failed". Strada.MCP's unity_playmode_verify now
 * writes Recordings/tests/playmode-last.json from the results.xml it parsed
 * and from the arguments it was called with. When that file is fresh for the
 * sprint it is the verdict; the prose stays the fallback for older tools.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const PLAYMODE_RUN_RECORD_REL = join("Recordings", "tests", "playmode-last.json");

export interface PlaymodeRunEvidence {
  /** failed === 0, at least one test PASSED, and the counts add up — computed here so no reader re-derives it loosely. */
  green?: boolean;
  found: boolean;
  stale?: boolean;
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  failedNames?: string[];
  unfiltered?: boolean;
  filter?: string;
  measuredAt?: string;
  /** One sentence in the shape the gate and the report already print. */
  detail?: string;
}

export function readPlaymodeRun(projectRoot: string, sinceMs: number): PlaymodeRunEvidence {
  const path = join(projectRoot, PLAYMODE_RUN_RECORD_REL);
  if (!existsSync(path)) return { found: false };
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return { found: false };
  }
  if (mtimeMs < sinceMs) return { found: false, stale: true };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return { found: false };
  }
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const total = num(raw.total);
  const failed = num(raw.failed);
  if (total === undefined || failed === undefined) return { found: false };
  const passed = num(raw.passed) ?? total - failed;
  const skipped = num(raw.skipped) ?? 0;
  const filter = typeof raw.filter === "string" && raw.filter.trim() !== "" ? raw.filter : undefined;
  // "unfiltered" is a flag the writer sets; a filter string beside it says
  // otherwise, and the string wins (Codex 2026-09-11 B#7).
  const unfiltered = raw.unfiltered === true && filter === undefined;
  // Counts that do not add up are not a run record: all-skipped, or
  // passed+failed+skipped ≠ total, never passes as green.
  const consistent = passed + failed + skipped === total || (num(raw.skipped) === undefined && passed + failed === total);
  const failedNames = Array.isArray(raw.failedNames) ? raw.failedNames.map(String).slice(0, 50) : [];
  const scope = unfiltered ? "unfiltered — the whole PlayMode suite" : `filter: ${filter ?? (typeof raw.categories === "string" ? raw.categories : "narrowed")}`;
  const detail =
    total === 0
      ? `PlayMode run (NUnit): 0 tests executed (${scope})`
      : !consistent
      ? `PlayMode run (NUnit): counts do not add up — ${passed} passed, ${failed} failed, ${skipped} skipped of ${total} (${scope})`
      : failed === 0 && passed === 0
      ? `PlayMode run (NUnit): ${total} tests, none passed (${skipped} skipped; ${scope})`
      : failed === 0
      ? `PlayMode verification passed: ${passed} of ${total} tests passed (${scope})`
      : `PlayMode verification FAILED: ${failed} of ${total} tests failed (${scope})`;
  return {
    found: true,
    green: consistent && failed === 0 && passed > 0,
    total,
    passed,
    failed,
    skipped: num(raw.skipped),
    failedNames,
    unfiltered,
    ...(filter ? { filter } : {}),
    measuredAt: typeof raw.measuredAt === "string" ? raw.measuredAt : undefined,
    detail,
  };
}
