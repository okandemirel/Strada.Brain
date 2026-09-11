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
  /** The file exists but is not a run record — never read as silence. */
  malformed?: boolean;
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
  // Two milliseconds of tolerance, as the play-through verdict has: a file
  // touched in the same millisecond is not older than the attempt.
  if (mtimeMs + 2 < sinceMs) return { found: false, stale: true };
  // …and a touched file is not a fresh run. The writer stamps measuredAt from
  // the results it parsed; when it says the run predates this attempt, the
  // record is stale no matter what the filesystem says (Codex 2026-09-11 E#8:
  // copying yesterday's record refreshed its mtime and laundered yesterday's
  // 42/42 into today's final-sprint proof).
  const stamped = measuredAtMs(readStamp(path));
  if (stamped !== undefined && stamped + 2 < sinceMs) return { found: false, stale: true };
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    // `null`, a bare number, an array: JSON.parse accepts all of them and the
    // first property read then THREW, out of this function and into the
    // caller's best-effort catch, which kept the PREVIOUS attempt's green
    // verdict (Codex 2026-09-11 E#1). A record that is not an object is a
    // malformed record, and malformed is a verdict of its own.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { found: false, malformed: true };
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return { found: false, malformed: true };
  }
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const total = num(raw.total);
  const failed = num(raw.failed);
  if (total === undefined || failed === undefined) return { found: false, malformed: true };
  // An INVALID explicit field is not an absent one: {passed:"0",skipped:"10"}
  // fell back to the derived counts and a malformed all-skipped record read as
  // a full-suite pass (Codex 2026-09-11 D#31).
  const invalidField =
    (raw.passed !== undefined && num(raw.passed) === undefined) ||
    (raw.skipped !== undefined && num(raw.skipped) === undefined);
  const passed = num(raw.passed) ?? total - failed;
  const skipped = num(raw.skipped) ?? 0;
  const categories = typeof raw.categories === "string" && raw.categories.trim() !== "" ? raw.categories : undefined;
  // `categories` narrows a run exactly as `filter` does (Codex 2026-09-11 C#13).
  const filter = (typeof raw.filter === "string" && raw.filter.trim() !== "" ? raw.filter : undefined) ?? categories;
  // "unfiltered" is a flag the writer sets; a filter string beside it says
  // otherwise, and the string wins (Codex 2026-09-11 B#7).
  const unfiltered = raw.unfiltered === true && filter === undefined;
  // Counts that do not add up are not a run record: all-skipped, or
  // passed+failed+skipped ≠ total, never passes as green.
  const whole = (v: number): boolean => Number.isInteger(v) && v >= 0;
  const consistent =
    !invalidField &&
    whole(total) && whole(passed) && whole(failed) && whole(skipped) &&
    (passed + failed + skipped === total || (num(raw.skipped) === undefined && passed + failed === total));
  const failedNames = Array.isArray(raw.failedNames) ? raw.failedNames.map(String).slice(0, 50) : [];
  const scope = unfiltered ? "unfiltered — the whole PlayMode suite" : `filter: ${filter ?? (typeof raw.categories === "string" ? raw.categories : "narrowed")}`;
  const detail =
    total === 0
      ? `PlayMode run (NUnit): 0 tests executed (${scope})`
      : !consistent
      ? `PlayMode run (NUnit): counts do not add up — ${passed} passed, ${failed} failed, ${skipped} skipped of ${total} (${scope})`
      : failed === 0 && passed === 0
      ? `PlayMode run (NUnit): ${total} test(s) collected, NONE ran to a pass — ${skipped} skipped (${scope})`
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

/** The record's own `measuredAt`, read without committing to the rest of the file. */
function readStamp(path: string): unknown {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return (parsed as Record<string, unknown>).measuredAt;
  } catch {
    return undefined;
  }
}

/** An ISO timestamp the writer stamped, or undefined when it is absent or unreadable. */
export function measuredAtMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
