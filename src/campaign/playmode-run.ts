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

/**
 * How far behind the attempt's start a record's own stamp may be and still
 * belong to this attempt. The runner can be a different machine; clocks differ
 * by minutes, not by milliseconds (Codex 2026-09-11 G#8).
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;

export interface PlaymodeRunEvidence {
  /** failed === 0, at least one test PASSED, and the counts add up — computed here so no reader re-derives it loosely. */
  green?: boolean;
  found: boolean;
  stale?: boolean;
  /** The file exists but is not a run record — never read as silence. */
  malformed?: boolean;
  /**
   * The record carries no usable `measuredAt` of its own, so only the file's
   * mtime says it is fresh — and an mtime is refreshed by a copy. The final
   * sprint refuses such a record (Codex 2026-09-11 G#4).
   */
  stampMissing?: boolean;
  /**
   * The run id the writer stamped, when it stamped one. The campaign issues
   * an id per attempt and asks the verification tool to echo it; a record
   * carrying a DIFFERENT id belongs to another attempt, whatever its
   * timestamps say. Absent stays acceptable while the tool does not emit it
   * (the open half of Codex F#10 / I#11).
   */
  runId?: string;
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

export function readPlaymodeRun(projectRoot: string, sinceMs: number, expectRunId?: string): PlaymodeRunEvidence {
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
  // ONE READ, ONE OBJECT. The stamp check and the counts used to come from
  // two separate reads of the file, so a writer that replaced the record
  // between them had its counts accepted under the other record's stamp
  // (Codex 2026-09-11 H#11).
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { found: false };
  }
  // The mtime gate takes the SAME clock-skew allowance as the stamp: a real
  // remote run whose file mtime is a minute behind the coordinator was
  // rejected before the allowance was ever consulted (Codex 2026-09-11 H#10).
  // THE FILE CLOCK IS THIS MACHINE'S, so it is exact: the record is written
  // here, by the verification tool this attempt ran, and a file written before
  // the attempt began is a previous attempt's result. Two milliseconds of
  // tolerance, as the play-through verdict has, for a file touched in the same
  // millisecond.
  //
  // The five-minute allowance below is for the RECORD'S OWN stamp, which the
  // runner writes from its own clock and may be minutes behind ours. Applying
  // it here instead let a record written seconds before the attempt started
  // count as this attempt's proof — the cached-result laundering C#10 is
  // about. A runner on another machine transferring a file with its mtime
  // preserved is therefore still refused (Codex 2026-09-11 H#10); that needs a
  // run identity the tool does not yet issue, and accepting stale proof is the
  // worse of the two failures.
  if (mtimeMs + 2 < sinceMs) return { found: false, stale: true };
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
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
  // …and a touched file is not a fresh run. The writer stamps measuredAt from
  // the results it parsed; when it says the run predates this attempt, the
  // record is stale no matter what the filesystem says (Codex 2026-09-11 E#8:
  // copying yesterday's record refreshed its mtime and laundered yesterday's
  // 42/42 into today's final-sprint proof). CLOCK SKEW, not millisecond
  // precision: the runner may be another machine whose clock is minutes
  // behind the coordinator's (G#8).
  // A RECORD FROM ANOTHER ATTEMPT is not this attempt's proof, whatever its
  // clock says. The id is only compared when both sides have one, so a tool
  // that does not echo it yet behaves exactly as before.
  const stampedRunId = typeof raw.runId === "string" ? raw.runId.trim() : "";
  if (expectRunId && stampedRunId && stampedRunId !== expectRunId) {
    return { found: false, stale: true };
  }
  const stamped = measuredAtMs(raw.measuredAt);
  if (stamped !== undefined && stamped + CLOCK_SKEW_TOLERANCE_MS < sinceMs) return { found: false, stale: true };
  // A stamp from the FUTURE is fabrication, not skew: "2099-01-01" was
  // accepted as fresh evidence (Codex 2026-09-11 H#9). Beyond the same skew
  // window, the stamp is no stamp at all.
  const fabricated = stamped !== undefined && stamped > Date.now() + CLOCK_SKEW_TOLERANCE_MS;
  // A stamp that is MISSING, unparseable or impossible is not a fresh stamp.
  // The file's mtime is trivially refreshed by a copy, so such a record
  // carries no freshness of its own; it is reported so the caller can decide
  // (the final sprint requires one).
  const stampMissing = stamped === undefined || fabricated;
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
  // STRINGS, WITHOUT COERCION. `String(x)` throws on an entry whose
  // `toString` is not callable — `{toString:null}` — and the caller's
  // best-effort catch then swallowed the whole red record, so a run with a
  // failed test advanced a sprint (Codex 2026-09-12 V). A name that is not a
  // string is dropped; the FAILED COUNT is what the gate reads.
  const failedNames = Array.isArray(raw.failedNames)
    ? raw.failedNames.filter((n): n is string => typeof n === "string" && n.trim() !== "").slice(0, 50)
    : [];
  // THE PRODUCER'S OWN VERDICT outranks the counts it printed beside it: a
  // run that ended "Failed" or "Inconclusive", or that threw, was read as
  // green because failed came back 0 (Codex 2026-09-12 R#6).
  const overall = typeof raw.result === "string" ? raw.result.trim() : "";
  // THE PROCESS HAS TO HAVE SUCCEEDED. A record with ten of ten passing and
  // `exitCode: 42` beside them was green: the runner died and its counts
  // survived (Codex 2026-09-12 AB J4.1). An explicit non-zero exit, or an
  // exit that is there but unreadable, certifies nothing.
  const exitCode = raw.exitCode === undefined ? undefined : num(raw.exitCode);
  const processFailed = raw.exitCode !== undefined && exitCode !== 0;
  const overallSaysPass = overall === "" || /^(?:passed|success|succeeded|ok)$/i.test(overall);
  const exceptions = num(raw.exceptions) ?? 0;
  // A SUITE MOST OF WHICH NEVER RAN is not a whole-suite pass, whatever the
  // unfiltered flag says: 1 passed and 99 skipped of 100 was green.
  const mostlySkipped = skipped > passed;
  // …and a MINORITY that never ran is still not the whole suite passing. The
  // count rode invisibly inside "80 of 100 tests passed (unfiltered — the
  // whole PlayMode suite)", so twenty tests nobody ran read as twenty tests
  // that had (Codex 2026-09-12 U#F6). Which of them may be skipped is the
  // acceptance contract's to state — the producer must record the test
  // inventory and each skip's reason — so this discloses, and does not judge.
  const scope = unfiltered ? "unfiltered — the whole PlayMode suite" : `filter: ${filter ?? (typeof raw.categories === "string" ? raw.categories : "narrowed")}`;
  const detail =
    total === 0
      ? `PlayMode run (NUnit): 0 tests executed (${scope})`
      : !consistent
      ? `PlayMode run (NUnit): counts do not add up — ${passed} passed, ${failed} failed, ${skipped} skipped of ${total} (${scope})`
      : failed === 0 && passed === 0
      ? `PlayMode run (NUnit): ${total} test(s) collected, NONE ran to a pass — ${skipped} skipped (${scope})`
      : !overallSaysPass
      ? `PlayMode run (NUnit): the runner's own verdict is "${overall}" — ${passed} of ${total} passed (${scope})`
      : exceptions > 0
      ? `PlayMode run (NUnit): ${exceptions} runtime exception(s) during the run — ${passed} of ${total} passed (${scope})`
      : processFailed
      ? `PlayMode run (NUnit): the runner exited ${exitCode ?? "with an unreadable code"} — ${passed} of ${total} passed (${scope})`
      : mostlySkipped
      ? `PlayMode run (NUnit): ${skipped} of ${total} tests never ran — ${passed} passed (${scope})`
      : failed === 0
      ? `PlayMode verification passed: ${passed} of ${total} tests passed${skipped > 0 ? `, ${skipped} SKIPPED` : ""} (${scope})`
      : `PlayMode verification FAILED: ${failed} of ${total} tests failed (${scope})`;
  return {
    found: true,
    ...(typeof raw.runId === "string" && raw.runId.trim() !== "" ? { runId: raw.runId.trim() } : {}),
    ...(stampMissing ? { stampMissing: true } : {}),
    green:
      consistent && failed === 0 && passed > 0 && overallSaysPass && exceptions === 0 && !mostlySkipped && !processFailed,
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

/** An ISO timestamp the writer stamped, or undefined when it is absent or unreadable. */
export function measuredAtMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
