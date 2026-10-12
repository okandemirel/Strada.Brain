/**
 * One acceptance measurement: the system's own checks of a milestone's GDD
 * rows, and every row that passed before, run in one filtered batch on the
 * committed revision (GDD-drift plan W08's run, wired by W09).
 *
 * A worker writes the records the other gates read, so nothing here is taken
 * on trust: the checks are restored from the stored bytes first (what differed
 * is tamper), the previous record is removed so the one read afterwards can
 * only be this run's, the run is dispatched under a ticket the campaign
 * issued, and the record is admitted only when it is this run's, ran exactly
 * the tests asked for, skipped none, and its counts add up. Failures past the
 * record's 50-name cap are run again in chunks until every one has a name; a
 * failure followed by a pass on its one re-run is flaky (a check fault, never
 * a pass). A revision that moved while the run ran measured nothing.
 *
 * The campaign injects everything that touches the editor, git or the ledger,
 * so this file decides only what a run proves.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { PlaymodeRunEvidence } from "./playmode-run.js";
import { PLAYMODE_RUN_RECORD_REL } from "./playmode-run.js";
import { attributeRun, type ExpectedAcceptanceTest, type TestAttribution } from "./scope-verdict.js";
import {
  ACCEPTANCE_DIR,
  type AcceptanceCompileError,
  type AcceptanceRefusal,
  type AcceptanceRefusalKind,
  type AcceptanceRunResult,
  type AcceptanceSource,
} from "./scope-types.js";
import type { AcceptanceMaterializeMode, AcceptanceSyncResult } from "./acceptance-files.js";
import { FAILED_NAMES_CAP } from "./scope-settle.js";

/** One filtered batch, as the campaign ran it under its own ticket. */
export interface AcceptanceBatch {
  /** The id the campaign's ticket issued for this run. */
  readonly runId?: string;
  /** The run record read back after the run (Recordings/tests/playmode-last.json). */
  readonly record: PlaymodeRunEvidence;
  /** The tool's own output: failure messages and compile errors are only there. */
  readonly content?: string;
  /** Why the campaign refused this run's evidence (a receipt it did not admit, a record that is not this run's). */
  readonly refused?: AcceptanceRefusal;
}

export interface AcceptanceGateDeps {
  readonly projectRoot: string;
  /** Runs one batch with this NUnit -testFilter. Absent: no runner is wired, and nothing is admitted. */
  readonly runBatch?: (testFilter: string) => Promise<AcceptanceBatch>;
  /** The revision results bind to; "" when nothing binds the tree (uncommitted changes, an unreadable repository). */
  readonly revision: () => string | Promise<string>;
  /** Write the stored checks and the harness over whatever the folder holds, and say what differed. */
  readonly restore: (sources: readonly AcceptanceSource[], mode: AcceptanceMaterializeMode) => AcceptanceSyncResult;
  /** Take ephemeral checks back out of the project. */
  readonly removeEphemeral: () => void;
  /** Why no acceptance assembly can be built here (no Strada.Core, no runtime assembly), if so. */
  readonly assemblyRefusal?: () => AcceptanceRefusal | undefined;
  /** Serialize against the other writers of the project tree. */
  readonly lock?: () => Promise<{ readonly acquired: boolean; release(): void }>;
}

export interface AcceptanceMeasurement {
  readonly run: AcceptanceRunResult;
  /** One entry per expected test, by full name. */
  readonly tests: Readonly<Record<string, TestAttribution>>;
}

/** NUnit's -testFilter takes full names separated by ";". */
function filterOf(names: readonly string[]): string {
  return names.join(";");
}

/** "name" lines under "Failed:" in the tool's output, each followed by its indented message. */
export function failureMessagesIn(content: string | undefined): Array<{ name: string; message: string }> {
  if (!content) return [];
  const out: Array<{ name: string; message: string }> = [];
  const lines = content.split(/\r?\n/);
  let inFailed = false;
  let current: { name: string; message: string[] } | undefined;
  const flush = (): void => {
    if (current) out.push({ name: current.name, message: current.message.join(" ").replace(/\s+/g, " ").trim() });
    current = undefined;
  };
  for (const line of lines) {
    if (/^Failed:\s*$/.test(line)) {
      inFailed = true;
      continue;
    }
    if (!inFailed) continue;
    if (line.trim() === "") {
      // A blank line closes the list only when nothing is open beneath it.
      if (current === undefined) inFailed = false;
      continue;
    }
    const name = /^ {2}(\S.*)$/.exec(line);
    if (name && !/^ {3,}/.test(line)) {
      flush();
      current = { name: name[1]!.trim(), message: [] };
      continue;
    }
    if (current && /^ {4,}/.test(line) && !/^\s*--- output ---/.test(line)) {
      if (current.message.join(" ").length < 1_200) current.message.push(line.trim());
      continue;
    }
    if (!/^\s/.test(line)) {
      flush();
      inFailed = false;
    }
  }
  flush();
  return out;
}

/** `path(line,col): error CSxxxx: message` lines that name a file under the acceptance folder. */
export function acceptanceCompileErrorsIn(content: string | undefined): AcceptanceCompileError[] {
  if (!content) return [];
  const out: AcceptanceCompileError[] = [];
  const seen = new Set<string>();
  const re = /([^\s"'()]*StradaAcceptance[\\/][^\s"'()]+?\.cs)\((\d+)(?:,\d+)?\)\s*:\s*error\s+(CS\d+)\s*:\s*(.+)$/i;
  for (const line of content.split(/\r?\n/)) {
    if (!/error\s+CS\d+/i.test(line)) continue;
    const match = re.exec(line);
    if (!match) continue;
    const path = match[1]!.replace(/\\/g, "/");
    const at = path.toLowerCase().lastIndexOf(ACCEPTANCE_DIR.toLowerCase());
    const rel = at >= 0 ? path.slice(at) : path;
    const key = `${rel}:${match[2]}:${match[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: rel, line: Number(match[2]), code: match[3]!, message: match[4]!.trim().slice(0, 400) });
  }
  return out;
}

function refusal(kind: AcceptanceRefusalKind, detail: string): AcceptanceRefusal {
  return { kind, detail };
}

/**
 * Does the record read back describe the run an admitted receipt vouches
 * for? The receipt has to state the counts and the very filter asked for;
 * an admitted receipt that states neither binds nothing. Unlike the whole
 * suite's receipt, a narrowed scope is the point here — a different one is not.
 */
export function acceptanceDisagreesWithReceipt(
  payload: Record<string, unknown> | undefined,
  record: PlaymodeRunEvidence,
  filter: string,
): string | undefined {
  const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
  const total = count(payload?.["total"]);
  const passed = count(payload?.["passed"]);
  const failed = count(payload?.["failed"]);
  if (total === undefined || passed === undefined || failed === undefined) {
    return "the acceptance run's receipt was admitted but states no counts — nothing ties the record to the run";
  }
  const scope = typeof payload?.["filter"] === "string" ? (payload["filter"] as string).trim() : "";
  if (scope !== filter.trim()) return "the acceptance run's receipt names another test filter than the one asked for";
  const skipped = count(payload?.["skipped"]) ?? 0;
  const same = record.total === total && record.passed === passed && record.failed === failed && (record.skipped ?? 0) === skipped;
  return same
    ? undefined
    : `the acceptance record is not the run its receipt describes (receipt: ${passed} passed, ${failed} failed of ${total}; record: ${record.passed ?? "?"} passed, ${record.failed ?? "?"} failed of ${record.total ?? "?"})`;
}

/**
 * Is this record the run that was asked for? It must have been read back for
 * this run, be readable, have run exactly the filter requested, skipped
 * nothing, counted every test asked for, and add up.
 */
function admission(batch: AcceptanceBatch, filter: string, expected: number): AcceptanceRefusal | undefined {
  if (batch.refused) return batch.refused;
  const record = batch.record;
  if (!record.found) {
    return refusal(record.stale ? "foreign-record" : "no-record", record.stale
      ? "the run record on disk is another run's (its run id or its time is not this run's)"
      : record.malformed
        ? "the run left a record that is not a run record"
        : "the run left no record");
  }
  if (batch.runId !== undefined && record.runId !== undefined && record.runId !== batch.runId) {
    return refusal("foreign-record", `the record names run ${record.runId}, not ${batch.runId}`);
  }
  if ((record.filter ?? "") !== filter) {
    return refusal("foreign-record", "the record's test filter is not the one this run asked for");
  }
  const total = record.total ?? -1;
  const failed = record.failed ?? -1;
  const passed = record.passed ?? -1;
  const skipped = record.skipped ?? 0;
  if (skipped > 0) return refusal("skipped", `${skipped} of the ${total} test(s) were skipped`);
  if (total !== expected) {
    return refusal("count-mismatch", `the run counted ${total} test(s), not the ${expected} asked for — a check that does not compile is left out of the run`);
  }
  if (passed < 0 || failed < 0 || passed + failed !== total) {
    return refusal("count-mismatch", `the record's counts do not add up (${passed} passed, ${failed} failed of ${total})`);
  }
  return undefined;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Run the expected acceptance tests once and say, per test, what the run
 * proves. Never throws for a run that could not be taken: the refusal is the
 * answer, and the judge reads it as not measured, never as a pass.
 */
export async function measureAcceptance(
  deps: AcceptanceGateDeps,
  request: {
    readonly sources: readonly AcceptanceSource[];
    readonly expected: readonly ExpectedAcceptanceTest[];
    readonly mode: AcceptanceMaterializeMode;
    /** Tests that compiled in an earlier run: one that no longer does is a fail, not a check fault. */
    readonly compiledBefore: ReadonlySet<string>;
  },
): Promise<AcceptanceMeasurement> {
  const names = request.expected.map((t) => t.testName.trim());
  let revision = "";
  const result = (run: Omit<AcceptanceRunResult, "expected" | "revision">): AcceptanceMeasurement => {
    const full: AcceptanceRunResult = { ...run, expected: names, revision };
    return { run: full, tests: attributeRun(full, request.expected, request.compiledBefore).tests };
  };
  const empty = { failedNames: [], unattributed: 0, flaky: [], acceptanceCompileErrors: [], failures: [] } as const;
  const notAdmitted = (why: AcceptanceRefusal, tamper: readonly string[] = []): AcceptanceMeasurement =>
    result({ ...empty, admitted: false, refusal: why, tamper: [...tamper] });

  if (!deps.runBatch) return notAdmitted(refusal("no-runner", "no acceptance runner is configured (unity_playmode_verify is not wired to the campaign)"));
  const assembly = deps.assemblyRefusal?.();
  if (assembly) return notAdmitted(assembly);

  const lock = deps.lock ? await deps.lock() : undefined;
  if (lock && !lock.acquired) return notAdmitted(refusal("lock", "another writer holds the project write lock"));
  try {
    let tamper: string[];
    try {
      tamper = deps.restore(request.sources, request.mode).tamper;
    } catch (err) {
      return notAdmitted(refusal("runner-error", `the stored checks could not be written into the project (${err instanceof Error ? err.message : String(err)})`));
    }
    revision = await deps.revision();
    if (revision === "") {
      return notAdmitted(
        refusal("tree-moved", "no revision binds the project tree (it has uncommitted changes, or its repository cannot be read), so no result could be bound to one"),
        tamper,
      );
    }

    const runOnce = async (subset: readonly string[]): Promise<{ batch?: AcceptanceBatch; error?: string; filter: string }> => {
      const filter = filterOf(subset);
      try {
        rmSync(join(deps.projectRoot, PLAYMODE_RUN_RECORD_REL), { force: true });
      } catch (err) {
        return { error: `the previous run record could not be removed (${err instanceof Error ? err.message : String(err)})`, filter };
      }
      try {
        return { batch: await deps.runBatch!(filter), filter };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err), filter };
      }
    };

    const first = await runOnce(names);
    if (first.error !== undefined || first.batch === undefined) {
      return notAdmitted(refusal("runner-error", `the acceptance run could not be taken: ${(first.error ?? "no answer").slice(0, 400)}`), tamper);
    }
    const batch = first.batch;
    const compileErrors = acceptanceCompileErrorsIn(batch.content);
    const failures = failureMessagesIn(batch.content);
    const refused = admission(batch, first.filter, names.length);
    const record = batch.record;
    let failedNames = (record.failedNames ?? []).map((n) => n.trim()).filter((n) => n !== "");
    const counted = record.failed ?? failedNames.length;
    let unattributed = Math.max(0, counted - failedNames.length);

    // PAST THE CAP: the record names at most 50 failures. Every expected name
    // the record did not name is run again, a chunk at a time, until the
    // failures counted are all named; an unnamed failure is never a pass.
    if (refused === undefined && unattributed > 0 && failedNames.length >= FAILED_NAMES_CAP) {
      const named = new Set(failedNames);
      for (const chunk of chunks(names.filter((n) => !named.has(n)), FAILED_NAMES_CAP)) {
        const again = await runOnce(chunk);
        if (again.batch === undefined || admission(again.batch, again.filter, chunk.length) !== undefined) break;
        const more = (again.batch.record.failedNames ?? []).map((n) => n.trim()).filter((n) => chunk.includes(n));
        for (const name of more) named.add(name);
        failures.push(...failureMessagesIn(again.batch.content));
        if ((again.batch.record.failed ?? 0) > more.length) break;
      }
      failedNames = [...named];
      unattributed = Math.max(0, counted - failedNames.length);
    }

    // ONE RE-RUN of what failed: a check that fails and then passes measured
    // the harness or the clock, not the game. Named failures only.
    let flaky: string[] = [];
    if (refused === undefined && failedNames.length > 0 && unattributed === 0) {
      const again = await runOnce(failedNames);
      if (again.batch !== undefined && admission(again.batch, again.filter, failedNames.length) === undefined) {
        const stillFailing = new Set((again.batch.record.failedNames ?? []).map((n) => n.trim()));
        if ((again.batch.record.failed ?? 0) === stillFailing.size) {
          flaky = failedNames.filter((n) => !stillFailing.has(n));
        }
      }
    }

    // THE TREE MOVED while the run ran: whatever it says, it does not describe one revision.
    const after = await deps.revision();
    if (after !== revision) {
      return result({
        ...empty,
        admitted: false,
        refusal: refusal("tree-moved", `the revision moved while the acceptance run ran (${revision.slice(0, 8)} → ${after.slice(0, 8) || "no revision"})`),
        tamper,
        runId: batch.runId,
        acceptanceCompileErrors: compileErrors,
      });
    }

    return result({
      admitted: refused === undefined,
      ...(refused === undefined ? {} : { refusal: refused }),
      ...(batch.runId === undefined ? {} : { runId: batch.runId }),
      ...(record.total === undefined ? {} : { total: record.total }),
      failedNames: failedNames.filter((n) => !flaky.includes(n)),
      unattributed,
      flaky,
      acceptanceCompileErrors: compileErrors,
      tamper,
      failures,
    });
  } finally {
    if (request.mode === "ephemeral") {
      try {
        deps.removeEphemeral();
      } catch {
        // Left behind, the next restore puts the folder right again.
      }
    }
    lock?.release();
  }
}
