/**
 * The scope gate's judge (GDD-drift plan W08, M2 + M3).
 *
 * In the measured campaign six of six milestones went green on prose: a worker's
 * report, the verifier's flags, its own tests. Five of their tips carried the
 * system's own "I got stuck" stamp. Here a milestone is green only when two
 * things pass in one acceptance run the system admitted, on the committed
 * revision: its own GDD rows, and every row that passed before.
 *
 *   GREEN ⇔ compile.ran ∧ compile.ok ∧ no tamper
 *         ∧ (OWN ∪ REG = ∅ ∨ run.admitted)
 *         ∧ ∀ row ∈ OWN ∪ REG: pass(row)
 *         ∧ (key = done ∨ scopeProven)
 *         ∧ (OWN ≠ ∅ ∨ (key = done ∧ the four gates passed ∧ ¬proseFailure))
 *
 *   scopeProven ⇔ OWN ≠ ∅ ∧ every OWN row passes
 *               ∧ every OWN test was written by a model that did not work on the milestone
 *
 * When it is not green, every reason carries its class, and the verdict takes
 * the worst present: red (charged after the first free bounce), then
 * check-fault (the writer repairs the system's own check), then unmeasurable
 * (never charged). An outage key is unmeasurable, so it always yields to any
 * red reason.
 *
 * THE `error` KEY. The node bridge sets it only when the runtime threw — the
 * machinery failed, which says nothing about the work. W00 put it with the
 * red keys so `worstTerminal` ranks it above an outage, and that order stays.
 * The judge treats it as it treats missing infrastructure: unmeasurable,
 * never charged, outranked by any red reason, and no bar to a scope that
 * independent checks proved. W00's worry, that an uncharged run is
 * resubmitted forever, is bounded where the unmeasurable state is acted on
 * (one uncharged resubmit, then park), not by charging the worker for a
 * crash. A worker's own red key in another node still wins: `worstTerminal`
 * ranks every other red key above `error`.
 *
 * A completion gate that is `not-armed` does not apply to the sprint, so it
 * cannot fail it; a gate with no recorded outcome did not pass.
 *
 * Pure: no file, clock, process or randomness. Everything it reads arrives in
 * GreenInput, which is stored whole with each judgement so any verdict can be
 * replayed.
 */

import {
  OUTAGE_TERMINALS,
  RED_TERMINALS,
  isTerminalKey,
  worstTerminal,
  type RunIntegrity,
  type TerminalKey,
} from "../agents/autonomy/terminal-key.js";
import type {
  AcceptanceRunResult,
  AcceptanceSource,
  AcceptanceWriter,
  CompletionGate,
  GreenInput,
  GreenReason,
  Judgement,
  ReasonClass,
  RequirementRow,
  RowOutcome,
  RowResult,
} from "./scope-types.js";

const CLASS_RANK: Record<ReasonClass, number> = { red: 2, "check-fault": 1, unmeasurable: 0 };

const COMPLETION_GATES: readonly CompletionGate[] = ["visualEvidence", "noWork", "art", "prosOnly"];

/**
 * The class a terminal key is judged in, or undefined for `done`. Only the
 * worker's own failure to finish is red; a provider stop, a crash of the
 * runtime (`error`) and an interruption are never charged.
 */
export function terminalReasonClass(key: TerminalKey): ReasonClass | undefined {
  if (key === "done") return undefined;
  if (key === "error") return "unmeasurable";
  if (RED_TERMINALS.has(key)) return "red";
  return "unmeasurable";
}

/**
 * Look and feel, aspirations, and rows a person waived or the plan excluded
 * never block. The settle path filters them out of OWN; the judge filters
 * again, because a row that never blocks must not block by being passed in.
 *
 * Exported so the rows a worker is shown (acceptance-prompt.ts) and the rows
 * the report counts (scope-report.ts) are decided by this rule, not by copies
 * of it that could drift apart from the verdict.
 */
export function rowDecides(row: RequirementRow): boolean {
  return row.status !== "excluded" && row.status !== "waived" && row.kind !== "aspiration" && row.kind !== "judgement";
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The row as a reader finds it in the GDD: its label or id, where it sits, and its own words. */
function rowName(row: RequirementRow): string {
  const where = row.sectionNumber ? `§${row.sectionNumber}` : row.section;
  return `${row.label ?? row.rid} (${where}, line ${row.line}): "${clip(row.text, 160)}"`;
}

/** A model name without its provider prefix, without case. */
function modelId(name: string): string {
  const trimmed = name.trim().toLowerCase();
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

interface WrittenTest {
  readonly testName: string;
  readonly writer: AcceptanceWriter;
}

function testsFor(rid: string, sources: readonly AcceptanceSource[]): WrittenTest[] {
  const out: WrittenTest[] = [];
  for (const file of sources) {
    for (const test of file.tests) {
      if (test.rid === rid) out.push({ testName: test.testName, writer: test.writer ?? file.writer });
    }
  }
  return out;
}

/** The row's own current test, for naming it when its file is not among the sources passed in. */
function currentTestName(row: RequirementRow): string | undefined {
  for (const check of row.checks) {
    if (check.kind === "test" && check.supersededAtMs === undefined) return check.testName;
  }
  return undefined;
}

function hasCheck(row: RequirementRow, sources: readonly AcceptanceSource[]): boolean {
  return (
    row.checks.some((c) => c.kind !== "test" || c.supersededAtMs === undefined) ||
    testsFor(row.rid, sources).length > 0
  );
}

/**
 * Written by a model that did not work on the milestone. The flag the writer
 * recorded is not enough on its own: a later attempt may have failed over to
 * the writer's model, so a writer among this run's workers is not independent.
 * A row decided without a stored test (a play-through scenario, a delivery
 * claim) proves its result but not scope; the exemption is for written checks.
 */
function independentlyChecked(row: RequirementRow, sources: readonly AcceptanceSource[], workers: ReadonlySet<string>): boolean {
  const tests = testsFor(row.rid, sources);
  return (
    tests.length > 0 &&
    tests.every((t) => t.writer.independence === "different-model" && !workers.has(modelId(t.writer.model)))
  );
}

/**
 * The key that speaks for the run, folded from every key it carried. A
 * stored `worst` that disagrees with its own keys cannot hide a red one.
 * Undefined when no readable key was recorded — not a clean finish.
 */
function runEnding(integrity: RunIntegrity | undefined): TerminalKey | undefined {
  if (!integrity) return undefined;
  const keys = [integrity.worst, ...(Array.isArray(integrity.terminalKeys) ? integrity.terminalKeys : [])].filter(isTerminalKey);
  return worstTerminal(keys);
}

function runRefusal(input: GreenInput): string | undefined {
  const run = input.run;
  if (!run) return `no acceptance run was taken on ${input.revision}`;
  if (!run.admitted) {
    return `the acceptance run was not admitted (${run.refusal?.kind ?? "no reason recorded"})${run.refusal?.detail ? `: ${clip(run.refusal.detail, 300)}` : ""}`;
  }
  if (run.revision !== input.revision) return `the acceptance run measured ${run.revision}, not the committed revision ${input.revision}`;
  return undefined;
}

export function judgeMilestone(input: GreenInput): Judgement {
  const reasons: GreenReason[] = [];
  const caveats: string[] = [];
  const push = (reason: GreenReason): void => {
    reasons.push(reason);
  };

  if (!input.compile.ran) {
    push({
      reasonClass: "unmeasurable",
      code: "compile-not-run",
      detail: `the compile on ${input.revision} was not measured${input.compile.detail ? `: ${clip(input.compile.detail, 300)}` : ""}`,
    });
  } else if (!input.compile.ok) {
    push({
      reasonClass: "red",
      code: "compile-failed",
      detail: `the project does not compile on ${input.revision}${input.compile.detail ? `: ${clip(input.compile.detail, 300)}` : ""}`,
    });
  }

  const tampered = [...new Set([...input.tamper, ...(input.run?.tamper ?? [])])];
  if (tampered.length > 0) {
    push({
      reasonClass: "red",
      code: "tamper",
      detail: `system-owned acceptance file(s) were changed outside the system and restored: ${tampered.join(", ")}`,
    });
  }

  const own: RequirementRow[] = [];
  const seen = new Set<string>();
  for (const row of input.own) {
    if (rowDecides(row) && !seen.has(row.rid)) {
      seen.add(row.rid);
      own.push(row);
    }
  }
  const regression: RequirementRow[] = [];
  for (const row of input.regression) {
    if (rowDecides(row) && !seen.has(row.rid)) {
      seen.add(row.rid);
      regression.push(row);
    }
  }
  const disclosed = input.own.filter((row) => !rowDecides(row)).length;

  // A row passes only inside an admitted run on this revision. A run that
  // counted failures it could not name has no passes to give.
  let runAdmitted = false;
  if (own.length + regression.length > 0) {
    const refused = runRefusal(input);
    if (refused !== undefined) {
      push({ reasonClass: "unmeasurable", code: "run-not-admitted", detail: refused });
    } else if ((input.run as AcceptanceRunResult).unattributed !== 0) {
      push({
        reasonClass: "unmeasurable",
        code: "row-unmeasured",
        detail: `the acceptance run counted ${String((input.run as AcceptanceRunResult).unattributed)} failure(s) no test name accounts for, so none of its passes is read as one`,
      });
    } else {
      runAdmitted = true;
    }
  }

  const judgeRow = (row: RequirementRow, regressed: boolean): boolean => {
    const tests = testsFor(row.rid, input.sources);
    const named = tests[0]?.testName ?? currentTestName(row);
    const at = { rid: row.rid, ...(named === undefined ? {} : { testName: named }) };
    const result: RowResult | undefined = input.results[row.rid];
    if (result === undefined || result.revision !== input.revision) {
      if (!hasCheck(row, input.sources)) {
        push({ reasonClass: "check-fault", code: "row-no-check", detail: `${rowName(row)} has no system check yet`, ...at });
      } else if (runAdmitted) {
        const stale = result === undefined ? "" : ` (its last result is from ${result.revision})`;
        push({ reasonClass: "unmeasurable", code: "row-not-run", detail: `${rowName(row)} was not measured on ${input.revision}${stale}`, ...at });
      }
      return false;
    }
    const said = clip(result.detail, 300);
    switch (result.outcome as RowOutcome) {
      case "pass":
        return runAdmitted;
      case "fail":
        push({
          reasonClass: "red",
          code: regressed ? "regression" : "row-failing",
          detail: regressed
            ? `regression: ${rowName(row)} passed before and fails on ${input.revision}: ${said}`
            : `${rowName(row)} fails on ${input.revision}: ${said}`,
          ...at,
        });
        return false;
      case "flaky":
        push({ reasonClass: "check-fault", code: "row-flaky", detail: `${rowName(row)}: its check failed, then passed on the re-run: ${said}`, ...at });
        return false;
      case "check-fault":
        push({ reasonClass: "check-fault", code: "row-check-fault", detail: `${rowName(row)}: its check is at fault: ${said}`, ...at });
        return false;
      case "not-run":
        push({ reasonClass: "unmeasurable", code: "row-not-run", detail: `${rowName(row)} did not run: ${said}`, ...at });
        return false;
      default:
        push({ reasonClass: "unmeasurable", code: "row-unmeasured", detail: `${rowName(row)} was not measured: ${said}`, ...at });
        return false;
    }
  };

  let ownPass = true;
  for (const row of own) if (!judgeRow(row, false)) ownPass = false;
  for (const row of regression) judgeRow(row, true);

  const workers = new Set((input.integrity?.workerModels ?? []).map(modelId));
  const sameModel = own.filter((row) => !independentlyChecked(row, input.sources, workers)).length;
  const scopeProven = own.length > 0 && ownPass && sameModel === 0;

  const key = runEnding(input.integrity);
  if (key !== "done" && !scopeProven) {
    if (key === undefined) {
      push({ reasonClass: "unmeasurable", code: "terminal", detail: "how the run ended was not recorded, so it is not a clean finish" });
    } else {
      const why =
        key === "error"
          ? "the runtime threw; that measures nothing about the work"
          : OUTAGE_TERMINALS.has(key)
            ? "the provider stopped it; that is not charged to the work"
            : key === "interrupted"
              ? "it was interrupted, not finished"
              : "the run did not finish its work";
      push({
        reasonClass: terminalReasonClass(key) ?? "unmeasurable",
        code: "terminal",
        detail: `the run ended "${key}" (${why}), and ${own.length === 0 ? "the milestone owns no GDD rows that could prove its scope" : "no independent check proved the milestone's scope"}`,
        terminal: key,
      });
    }
  }

  if (own.length === 0) {
    for (const gate of COMPLETION_GATES) {
      const outcome = input.gates?.[gate];
      if (outcome === "fail") {
        push({ reasonClass: "red", code: "gate-failed", detail: `the ${gate} gate failed in this attempt, and the milestone owns no GDD rows to decide it` });
      } else if (outcome !== "pass" && outcome !== "not-armed") {
        push({ reasonClass: "unmeasurable", code: "gate-failed", detail: `the ${gate} gate has no recorded outcome for this attempt` });
      }
    }
    if (input.proseFailure) {
      push({ reasonClass: "red", code: "prose-failure", detail: "the worker's result reads as a terminal failure, and the milestone owns no GDD rows to decide it" });
    }
  }

  if (reasons.length > 0) {
    const ordered = reasons
      .map((reason, i) => ({ reason, i }))
      .sort((a, b) => CLASS_RANK[b.reason.reasonClass] - CLASS_RANK[a.reason.reasonClass] || a.i - b.i)
      .map(({ reason }) => reason);
    return { green: false, state: ordered[0]!.reasonClass, reasons: ordered };
  }

  if (own.length === 0) {
    caveats.push("owns no GDD rows: green on the run ending done, a clean compile and the four completion gates (vacuous)");
  } else {
    if (key !== "done") {
      caveats.push(`the run ended "${key ?? "unrecorded"}", but every owned row passed checks written by a model that did not work on the milestone (scope proven)`);
    }
    if (sameModel > 0) {
      caveats.push(`${sameModel} owned row(s) have no check written by a model independent of the milestone's workers (same-model writer, or no written test)`);
    }
    const failedGates = COMPLETION_GATES.filter((g) => input.gates?.[g] === "fail");
    if (failedGates.length > 0) {
      caveats.push(`the ${failedGates.join(", ")} gate(s) failed; the milestone's GDD rows decide`);
    }
  }
  if (disclosed > 0) {
    caveats.push(`${disclosed} owned row(s) never block (look and feel, aspirations, waived or excluded) and are disclosed only`);
  }
  if (input.integrity?.source === "legacy-stamp") {
    caveats.push("how the run ended was decoded from the system's own stamps in its result (settled before the key was carried)");
  }
  return { green: true, basis: own.length > 0 ? "proven" : "vacuous", caveats };
}

// =============================================================================
// ATTRIBUTING A RUN TO ITS TESTS
// =============================================================================

/** An acceptance test the run was asked for, and the file that holds it (compile errors are reported per file). */
export interface ExpectedAcceptanceTest {
  readonly testName: string;
  readonly path: string;
}

export interface TestAttribution {
  readonly outcome: RowOutcome;
  readonly detail: string;
  /** Set when its file did not compile: true means it had compiled before, so it is a fail. */
  readonly compiledBefore?: boolean;
}

export interface RunAttribution {
  /** One entry per expected test, by full name. */
  readonly tests: Readonly<Record<string, TestAttribution>>;
  /** Failures the run counted that no expected name accounts for. */
  readonly unattributed: number;
}

function normalPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "").trim().toLowerCase();
}

function samePath(a: string, b: string): boolean {
  const x = normalPath(a);
  const y = normalPath(b);
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

/**
 * Which expected test passed, failed, faulted or was not measured, from one
 * acceptance run.
 *
 * A record refused as short (`count-mismatch`) or `skipped` is still this
 * run's, on this tree: its passes are refused — nobody can say which tests ran
 * — but a test it names as failed did run and fail, and the acceptance compile
 * errors explain the shortfall. Any other refusal (another run's record, a
 * tree that moved, no record) measured nothing here, so nothing in it is
 * charged.
 *
 * A test whose file does not compile is a fail when it compiled in an earlier
 * run (the worker's change broke it) and a check fault when it never did (the
 * writer's). The acceptance tests share one assembly, so when any file is
 * broken the others did not run either.
 *
 * Failures nobody named mean no unnamed test can be read as a pass.
 */
export function attributeRun(
  record: AcceptanceRunResult,
  expected: readonly ExpectedAcceptanceTest[],
  compiledBefore: ReadonlySet<string>,
): RunAttribution {
  const refusal = record.refusal?.kind;
  const thisRun = record.admitted || refusal === "count-mismatch" || refusal === "skipped";
  const wanted = new Set(expected.map((t) => t.testName.trim()));
  const failed = new Set(record.failedNames.map((n) => n.trim()).filter((n) => n !== ""));
  const flaky = new Set(record.flaky.map((n) => n.trim()).filter((n) => n !== ""));
  const counted = record.unattributed;
  // An unreadable count is not zero.
  const unnamed = Number.isInteger(counted) && counted >= 0 ? counted : 1;
  const unattributed = unnamed + [...failed].filter((n) => !wanted.has(n)).length;
  const messages = new Map(record.failures.map((f) => [f.name.trim(), f.message]));
  const compileErrors = record.acceptanceCompileErrors;
  const refused = `the acceptance run was not admitted (${refusal ?? "no reason recorded"})${record.refusal?.detail ? `: ${clip(record.refusal.detail, 300)}` : ""}`;

  const tests: Record<string, TestAttribution> = {};
  for (const test of expected) {
    const name = test.testName.trim();
    if (!thisRun) {
      tests[name] = { outcome: "unmeasured", detail: refused };
      continue;
    }
    const broken = compileErrors.find((e) => samePath(e.path, test.path));
    if (broken !== undefined) {
      const where = `${broken.path}${broken.line === undefined ? "" : `(${broken.line})`}`;
      const error = `${where}: ${broken.code ? `${broken.code} ` : ""}${clip(broken.message, 300)}`;
      tests[name] = compiledBefore.has(name)
        ? { outcome: "fail", compiledBefore: true, detail: `its check compiled before and no longer compiles: ${error}` }
        : { outcome: "check-fault", compiledBefore: false, detail: `its acceptance file does not compile: ${error}` };
      continue;
    }
    if (flaky.has(name)) {
      tests[name] = { outcome: "flaky", detail: `failed, then passed on the re-run${messages.has(name) ? `: ${clip(messages.get(name)!, 300)}` : ""}` };
      continue;
    }
    if (failed.has(name)) {
      tests[name] = { outcome: "fail", detail: messages.has(name) ? clip(messages.get(name)!, 300) : "failed (the run recorded no message)" };
      continue;
    }
    if (!record.admitted) {
      tests[name] =
        compileErrors.length > 0
          ? { outcome: "not-run", detail: `the acceptance assembly did not compile (${compileErrors.map((e) => e.path).join(", ")}), so it did not run` }
          : { outcome: "unmeasured", detail: refused };
      continue;
    }
    if (unattributed > 0) {
      tests[name] = {
        outcome: "unmeasured",
        detail: `the run counted ${unattributed} failure(s) no expected test name accounts for, so its pass is not read as one`,
      };
      continue;
    }
    tests[name] = { outcome: "pass", detail: `passed in run ${record.runId ?? "(no run id)"} on ${record.revision}` };
  }
  return { tests, unattributed };
}

// =============================================================================
// CLOSURE AND LEGACY RUNS
// =============================================================================

/**
 * A requirement is closed by the ledger only when its row passed on the
 * current revision, through a check that is still current and that the
 * independent review did not call weak. A worker's prose, its own tests or a
 * landed-line quote close nothing. A waived row is a person's decision, not
 * evidence, so it is not closed here.
 */
export function closesByLedger(row: RequirementRow, revision: string): boolean {
  if (revision.trim() === "") return false;
  if (row.status === "excluded" || row.status === "waived") return false;
  const last = row.last;
  if (last === undefined || last.outcome !== "pass" || last.revision !== revision) return false;
  const current = row.checks.filter((c) => c.kind !== "test" || c.supersededAtMs === undefined);
  if (current.length === 0) return false;
  return !current.some((c) => c.kind === "test" && c.weak !== undefined);
}

/** Finds the system's own terminal stamps in a result: W01's `systemStampsIn`. */
export type StampDecoder = (text: string) => readonly TerminalKey[];

/**
 * How a run settled before the key was carried ended, read from the stamps
 * the system wrote into its full result. No stamp is `done`.
 *
 * The decoder is a parameter, and a required one: a default that finds
 * nothing would read every stuck run as `done`, which is how the measured campaign went
 * green. The settle path passes W01's `systemStampsIn`.
 */
export function legacyRunIntegrity(tipResult: string | null | undefined, stampsIn: StampDecoder): RunIntegrity {
  const found = typeof tipResult === "string" && tipResult !== "" ? stampsIn(tipResult).filter(isTerminalKey) : [];
  const terminalKeys: TerminalKey[] = found.length > 0 ? [...found] : ["done"];
  return { terminalKeys, worst: worstTerminal(terminalKeys) ?? "done", source: "legacy-stamp", workerModels: [] };
}
