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
  const unfiltered = raw.unfiltered === true;
  const filter = typeof raw.filter === "string" ? raw.filter : undefined;
  const failedNames = Array.isArray(raw.failedNames) ? raw.failedNames.map(String).slice(0, 50) : [];
  const scope = unfiltered ? "unfiltered — the whole PlayMode suite" : `filter: ${filter ?? (typeof raw.categories === "string" ? raw.categories : "narrowed")}`;
  const detail =
    total === 0
      ? `PlayMode run (NUnit): 0 tests executed (${scope})`
      : failed === 0
      ? `PlayMode verification passed: ${passed} of ${total} tests passed (${scope})`
      : `PlayMode verification FAILED: ${failed} of ${total} tests failed (${scope})`;
  return {
    found: true,
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
