/**
 * What the settle path does with a scope verdict.
 *
 * The judge (scope-verdict.ts) says whether a milestone is green and, when it
 * is not, why — every reason with its class. This module turns that into the
 * one thing the campaign does next, and into the words the worker reads:
 *
 *   red           — bounced; the first bounce is free, later ones are charged,
 *                   and a milestone whose bounces ran out is parked
 *   check-fault   — the system's own check is repaired by its writer (bounded),
 *                   never charged; a fault that survives the repair parks
 *   unmeasurable  — an outage takes the outage path; a row the writer could not
 *                   observe gets one uncharged round that names what to expose;
 *                   any other machine reason gets one uncharged resubmit, then
 *                   the milestone parks
 *
 * Pure: no file, clock, process or randomness.
 */

import { OUTAGE_TERMINALS, RED_TERMINALS, isTerminalKey, worstTerminal, type RunIntegrity } from "../agents/autonomy/terminal-key.js";
import { ACCEPTANCE_DISPUTE_PREFIX } from "./acceptance-prompt.js";
import {
  ACCEPTANCE_DIR,
  isAcceptanceTestName,
  type AcceptanceWriteFaultCause,
  type GreenReason,
  type Judgement,
  type ReasonClass,
  type RequirementRow,
} from "./scope-types.js";

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// =============================================================================
// THE WORKER'S OWN TEST RUNS
// =============================================================================

/** NUnit names a run record carries at most; a longer list was cut, so what it left out is unknown. */
export const FAILED_NAMES_CAP = 50;

/**
 * Does a red run fail ONLY on the system's acceptance checks? Then the scope
 * gate decides the milestone — a worker cannot fix a sprint into green by
 * passing its own tests, and must not be failed for a check the gate is about
 * to measure itself. Every failed name has to be an acceptance test, nothing
 * may have been left out of the list, and a list at the cap is a cut list.
 */
export function failsOnlyOnAcceptance(failedNames: readonly string[] | undefined, omitted: number | undefined): boolean {
  if (!Array.isArray(failedNames) || failedNames.length === 0) return false;
  if (failedNames.length >= FAILED_NAMES_CAP) return false;
  if (omitted !== undefined && omitted !== 0) return false;
  return failedNames.every((name) => typeof name === "string" && isAcceptanceTestName(name));
}

/** A worker's run record as `readPlaymodeRun` reads it, as far as the acceptance exemption needs it. */
export interface WorkerRunRecord {
  readonly found: boolean;
  readonly stampMissing?: boolean;
  readonly redOnlyByFailures?: boolean;
  readonly total?: number;
  readonly failed?: number;
  readonly failedNames?: readonly string[];
}

/**
 * A record red ONLY because acceptance tests failed: every failure named, each
 * name an acceptance test, and nothing else red in it. Runtime exceptions, a
 * failed process, a suite that mostly never ran and counts that do not add up
 * are not the acceptance checks' to answer for, so they still fail the sprint.
 */
export function recordFailsOnlyOnAcceptance(record: WorkerRunRecord | undefined): boolean {
  if (record?.found !== true || record.redOnlyByFailures !== true) return false;
  return failsOnlyOnAcceptance(record.failedNames, (record.failed ?? 0) - (record.failedNames?.length ?? 0));
}

const PROSE_COUNTS_RE = /(\d+) of (\d+) tests? failed/i;

/**
 * Whether a red verdict read off the tool's prose fails only on acceptance
 * tests. The prose takes names off the red line alone, and at most five: the
 * whole-suite line ("1 of 9 tests failed (unfiltered — …)") names none. So
 * when it names nothing, or names only acceptance tests and leaves some out,
 * this attempt's fresh run record decides — one with its own stamp, red only
 * on acceptance tests, and of the same run: the red line states counts, and
 * they are its counts. A name of any other test in the prose fails the sprint
 * as before.
 */
export function proseFailsOnlyOnAcceptance(
  prose: { readonly detail?: string; readonly failedTests?: readonly string[]; readonly failedTestsOmitted?: number } | undefined,
  record: WorkerRunRecord | undefined,
): boolean {
  const named = prose?.failedTests ?? [];
  const omitted = prose?.failedTestsOmitted ?? 0;
  if (named.some((name) => !isAcceptanceTestName(name))) return false;
  if (named.length > 0 && omitted === 0) return failsOnlyOnAcceptance(named, 0);
  if (!recordFailsOnlyOnAcceptance(record) || record?.stampMissing === true) return false;
  // THE COUNTS ARE THE ONLY TIE between the line and the record. A red line
  // with none — "the game threw", "the scene did not load", "nothing
  // compiled" — is red for a reason no failed name answers, and an
  // acceptance-only record from an earlier run in the attempt waived it.
  const counts = PROSE_COUNTS_RE.exec(prose?.detail ?? "");
  return counts !== null && Number(counts[1]) === record?.failed && Number(counts[2]) === record.total;
}

// =============================================================================
// HOW THE RUN ENDED
// =============================================================================

/**
 * The executor's own stamp for a run whose work never reached the project
 * (the lease commit was lost): "PUBLICATION FAILED: …" at the start of a line.
 */
const PUBLICATION_LOST_RE = /(?:^|\n)\s*PUBLICATION FAILED: /;

export function publicationLost(text: string | null | undefined): boolean {
  return typeof text === "string" && PUBLICATION_LOST_RE.test(text);
}

/**
 * The run ended on the machinery, not on the work: every `error` key it
 * carries was thrown outside the worker's run (the node bridge's catch, a
 * lease commit that was lost), and no key of the worker's own is red. Such a
 * run measures nothing about the work, so it is not charged.
 *
 * A lost publication reads as a plain `error` with no infrastructure flag —
 * the executor fails the run with its own stamp instead — so the stamp
 * counts as that flag here.
 */
export function infrastructureOnly(
  integrity: (RunIntegrity & { readonly infrastructureErrors?: number }) | undefined,
  settledText: string | null | undefined,
): boolean {
  if (!integrity) return publicationLost(settledText);
  const keys = (Array.isArray(integrity.terminalKeys) ? integrity.terminalKeys : []).filter(isTerminalKey);
  const errors = keys.filter((k) => k === "error").length;
  if (errors === 0) return false;
  const thrown = publicationLost(settledText) ? errors : Math.max(0, Math.min(errors, integrity.infrastructureErrors ?? 0));
  if (thrown < errors) return false;
  const rest = worstTerminal(keys.filter((k) => k !== "error"));
  return rest === undefined || !RED_TERMINALS.has(rest);
}

/**
 * How a run ended once W01's rule is applied, on every path the settle reads
 * it: the `error` keys the machinery threw (`infrastructureErrors`, or the
 * executor's lost-publication stamp) measured nothing about the work, so when
 * every `error` is the machinery's and an outage or a red key sits beside
 * them, those keys speak — a quota stop behind a bridge throw takes the
 * outage path. With nothing else beside them the run stays unmeasurable.
 * The count of thrown errors is made explicit, so the judge can tell an
 * `error` the worker's own run raised, which is red. A run decoded from
 * legacy stamps carries no such count and is left as it is.
 */
export function workerIntegrity<T extends RunIntegrity & { readonly infrastructureErrors?: number }>(
  integrity: T | undefined,
  settledText: string | null | undefined,
): T | undefined {
  if (integrity === undefined || integrity.source !== "spine") return integrity;
  const keys = (Array.isArray(integrity.terminalKeys) ? integrity.terminalKeys : []).filter(isTerminalKey);
  const errors = keys.filter((k) => k === "error").length;
  const thrown = publicationLost(settledText) ? errors : Math.max(0, Math.min(errors, integrity.infrastructureErrors ?? 0));
  if (errors > 0 && thrown === errors) {
    const rest = keys.filter((k) => k !== "error");
    const beside = worstTerminal(rest);
    if (beside !== undefined && (RED_TERMINALS.has(beside) || OUTAGE_TERMINALS.has(beside))) {
      return { ...integrity, terminalKeys: rest, worst: beside, infrastructureErrors: 0 };
    }
  }
  return { ...integrity, infrastructureErrors: thrown };
}

/** The run stopped on the provider: the worst key it carried is an outage, so no red key of the worker's own is there. */
export function endedOnOutage(integrity: RunIntegrity | undefined): boolean {
  if (!integrity) return false;
  const keys = [integrity.worst, ...(Array.isArray(integrity.terminalKeys) ? integrity.terminalKeys : [])].filter(isTerminalKey);
  const worst = worstTerminal(keys);
  return worst !== undefined && OUTAGE_TERMINALS.has(worst);
}

// =============================================================================
// THE WRITER'S FAULTS
// =============================================================================

/**
 * A row the writer returned no check for. An outage (the call threw, no
 * model was healthy) measured nothing; every other cause is the system's own
 * check failing to exist, which its writer repairs. Neither is charged.
 */
export function writerFaultClass(cause: AcceptanceWriteFaultCause): ReasonClass {
  return cause === "call-failed" || cause === "no-writer" ? "unmeasurable" : "check-fault";
}

// =============================================================================
// WHAT A WORKER WRITES BACK
// =============================================================================

export interface WorkerDispute {
  /** The test name or row id the line names. */
  readonly target: string;
  readonly reason: string;
}

/** Lines read from the end of a report: a dispute is a closing statement, not something quoted along the way. */
const WORKER_LINE_WINDOW = 50;

/**
 * `ACCEPTANCE DISPUTE <test name or row id>: <reason>` lines among the last
 * lines of the worker's report, each target once (the last word on it wins).
 * A dispute is reviewed by the check's writer; it never passes a row.
 */
export function parseWorkerLines(output: string | null | undefined): { disputes: WorkerDispute[] } {
  if (typeof output !== "string" || output === "") return { disputes: [] };
  const lines = output.split(/\r?\n/).slice(-WORKER_LINE_WINDOW);
  const byTarget = new Map<string, WorkerDispute>();
  const prefix = ACCEPTANCE_DISPUTE_PREFIX.replace(/\s+/g, "\\s+");
  const re = new RegExp(`^\\s*(?:[-*>]\\s*)?${prefix}\\s+([^\\s:]+)\\s*:\\s*(\\S.*)$`);
  for (const line of lines) {
    const match = re.exec(line);
    if (!match) continue;
    const target = match[1]!.replace(/[`"']/g, "").trim();
    const reason = clip(match[2]!, 600);
    if (target === "" || reason === "") continue;
    byTarget.set(target, { target, reason });
  }
  return { disputes: [...byTarget.values()] };
}

// =============================================================================
// THE TIME BOX
// =============================================================================

/**
 * A milestone over its time box keeps half of what is still open, in GDD
 * order, and hands the rest to a sprint split off from it. Rows that already
 * pass stay where they are.
 */
export function timeBoxSplit(rows: readonly RequirementRow[]): { kept: RequirementRow[]; moved: RequirementRow[] } {
  const open = [...rows]
    .filter((row) => row.last?.outcome !== "pass")
    .sort((a, b) => a.span.start - b.span.start || a.line - b.line || (a.rid < b.rid ? -1 : a.rid > b.rid ? 1 : 0));
  const keep = Math.ceil(open.length / 2);
  return { kept: open.slice(0, keep), moved: open.slice(keep) };
}

// =============================================================================
// THE NEXT STEP
// =============================================================================

export type ScopeAction =
  | { readonly kind: "advance" }
  /** Red: the worker is sent back with the failing rows named; the first bounce is free. */
  | { readonly kind: "bounce"; readonly countAttempt: boolean }
  /** The provider stopped the run: the existing outage path, never charged. */
  | { readonly kind: "outage" }
  /** Nothing the worker did is measured yet: sent back once without charge. */
  | { readonly kind: "resubmit-uncharged"; readonly why: "unbound" | "unmeasurable" }
  /** The budget for this milestone ran out: it is parked and the ladder moves on. */
  | { readonly kind: "park" };

export interface ScopeBudgets {
  /** Scope bounces already sent for this milestone. */
  readonly bounces: number;
  /** maxMilestoneAttempts: bounces past it park the milestone. */
  readonly maxBounces: number;
  /** Uncharged resubmits already spent on a machine reason. */
  readonly resubmits: number;
}

/** One uncharged resubmit for a measurement the machine could not take, then the milestone parks. */
export const MAX_SCOPE_RESUBMITS = 1;

/**
 * What the campaign does with a verdict. Check faults are not decided here:
 * the settle path repairs them (within the writer's budgets) and measures
 * again before it asks, so a check fault that reaches this point survived its
 * repair, and the milestone parks with the row marked for a person.
 */
export function nextScopeAction(judgement: Judgement, budgets: ScopeBudgets): ScopeAction {
  if (judgement.green) return { kind: "advance" };
  if (judgement.state === "red") {
    if (budgets.bounces >= budgets.maxBounces) return { kind: "park" };
    return { kind: "bounce", countAttempt: budgets.bounces > 0 };
  }
  if (judgement.state === "check-fault") return { kind: "park" };
  const reasons = judgement.reasons;
  if (reasons.some((r) => r.code === "terminal" && r.terminal !== undefined && OUTAGE_TERMINALS.has(r.terminal))) {
    return { kind: "outage" };
  }
  // A row the writer could not observe: the worker is told once, uncharged,
  // what to make observable. The told round is red in the judge, so it never
  // reaches this branch again.
  if (reasons.length > 0 && reasons.every((r) => r.code === "row-unbound")) {
    return { kind: "resubmit-uncharged", why: "unbound" };
  }
  if (budgets.resubmits < MAX_SCOPE_RESUBMITS) return { kind: "resubmit-uncharged", why: "unmeasurable" };
  return { kind: "park" };
}

// =============================================================================
// THE WORDS THE WORKER READS
// =============================================================================

export const SCOPE_GATE_MARKER = "\n\n[SCOPE GATE — latest measurement]";
const BOUNCE_TEXT_CAP = 5_000;
const REASONS_LISTED = 12;

/** Remove the previous scope gate block, so the prompt carries only the latest measurement. */
export function withoutScopeBlock(prompt: string): string {
  const cut = prompt.indexOf(SCOPE_GATE_MARKER);
  return cut >= 0 ? prompt.slice(0, cut) : prompt;
}

function reasonLine(reason: GreenReason, failures: ReadonlyMap<string, string>): string {
  if (reason.code === "row-unbound") {
    return `- ${reason.rid ?? "a row"}: the system's check cannot observe it. Make this observable through a public type or service: ${clip(reason.detail, 300)}`;
  }
  const message = reason.testName !== undefined ? failures.get(reason.testName) : undefined;
  const test = reason.testName !== undefined ? ` [test ${reason.testName}]` : "";
  const said = message !== undefined && !reason.detail.includes(clip(message, 80)) ? ` — the check said: ${clip(message, 300)}` : "";
  return `- ${clip(reason.detail, 600)}${test}${said}`;
}

/**
 * The block appended to the prompt of a sprint the scope gate sent back. It
 * names each failing row by its GDD sentence, its test and what the test
 * said; a row the writer could not observe is named with what to expose.
 */
export function scopeBounceText(
  judgement: Extract<Judgement, { green: false }>,
  revision: string,
  failures: ReadonlyMap<string, string> = new Map(),
): string {
  const reasons = judgement.reasons;
  const listed = reasons.slice(0, REASONS_LISTED).map((r) => reasonLine(r, failures));
  const more = reasons.length > REASONS_LISTED ? [`- … and ${reasons.length - REASONS_LISTED} more reason(s).`] : [];
  const head =
    judgement.state === "red"
      ? `THE MILESTONE IS NOT GREEN on ${revision.slice(0, 8) || "the committed tree"}: the system's acceptance checks of its GDD rows do not pass.`
      : `THE MILESTONE WAS NOT MEASURED on ${revision.slice(0, 8) || "the committed tree"}: the system could not run its acceptance checks to a verdict. This attempt is not charged.`;
  const body = [
    head,
    ...listed,
    ...more,
    `Your own tests do not close these rows: the checks under ${ACCEPTANCE_DIR} are the system's, read-only, and restored before every measurement. ` +
      "Make the game do what each row says, then report.",
    `If a check is wrong about the GDD, write \`${ACCEPTANCE_DISPUTE_PREFIX} <test name or row id>: <why>\` as one of the last lines of your report; its writer reviews it. A dispute never passes a row.`,
  ].join("\n");
  const text = `${SCOPE_GATE_MARKER}\n${body}`;
  return text.length > BOUNCE_TEXT_CAP ? `${text.slice(0, BOUNCE_TEXT_CAP - 1)}…` : text;
}

// =============================================================================
// THE FINAL MILESTONE'S MISSING PROOFS
// =============================================================================

/**
 * The scope gate's missing proofs at delivery, in the campaign's own words.
 * The check-fault and not-admitted wordings are in UNMEASURABLE_PROOF_RE: a
 * proof the machine cannot produce revives the campaign twice and then asks a
 * person, instead of looping on something no retry changes.
 */
export const SCOPE_CHECKS_FAULTED_PROOF = "system-written acceptance checks could not be made to work";
export const SCOPE_NOT_ADMITTED_PROOF = "the acceptance run was not admitted";

export interface ScopeDeliveryProofs {
  readonly proofs: string[];
  readonly rowsFailing: boolean;
  readonly checksFaulted: boolean;
  readonly unmeasured: boolean;
}

/** Rows referred to by their GDD label (or id), a few at most. */
function rowRefs(rows: readonly RequirementRow[], max = 3): string {
  const refs = rows.slice(0, max).map((r) => `${r.label ?? r.rid} "${clip(r.text, 80)}"`);
  return `${refs.join("; ")}${rows.length > max ? `; and ${rows.length - max} more` : ""}`;
}

/**
 * What the scope gate still holds against delivery: the final milestone's
 * failing rows, every row whose check is at fault, and a final acceptance run
 * the system could not admit.
 */
export function scopeDeliveryProofs(input: {
  readonly verdict: Judgement | undefined;
  readonly revision: string;
  readonly rows: readonly RequirementRow[];
  readonly checkFaultRows: readonly RequirementRow[];
}): ScopeDeliveryProofs {
  const proofs: string[] = [];
  const byRid = new Map(input.rows.map((r) => [r.rid, r] as const));
  let rowsFailing = false;
  let unmeasured = false;
  if (input.verdict && !input.verdict.green) {
    const red = input.verdict.reasons.filter((r) => r.reasonClass === "red" && r.rid !== undefined);
    const redRows = [...new Set(red.map((r) => r.rid!))].map((rid) => byRid.get(rid)).filter((r): r is RequirementRow => r !== undefined);
    if (redRows.length > 0) {
      rowsFailing = true;
      proofs.push(`${redRows.length} GDD row(s) not passing on ${input.revision.slice(0, 8) || "the committed tree"}: ${rowRefs(redRows)}`.slice(0, 400));
    } else if (input.verdict.state === "red") {
      rowsFailing = true;
      proofs.push(`the scope gate is not green on ${input.revision.slice(0, 8) || "the committed tree"}: ${clip(input.verdict.reasons[0]?.detail ?? "no reason recorded", 300)}`);
    }
    const refused = input.verdict.reasons.find((r) => r.code === "run-not-admitted" || (r.code === "row-unmeasured" && r.rid === undefined));
    if (refused !== undefined) {
      unmeasured = true;
      proofs.push(`${SCOPE_NOT_ADMITTED_PROOF}: ${clip(refused.detail, 300)}`);
    } else if (input.verdict.state === "unmeasurable" && !rowsFailing) {
      unmeasured = true;
      proofs.push(`${SCOPE_NOT_ADMITTED_PROOF} to a verdict: ${clip(input.verdict.reasons[0]?.detail ?? "no reason recorded", 300)}`);
    }
  }
  const faulted = input.checkFaultRows;
  if (faulted.length > 0) {
    proofs.push(`${SCOPE_CHECKS_FAULTED_PROOF} for ${faulted.length} row(s), so a person decides: ${rowRefs(faulted)}`.slice(0, 400));
  }
  return { proofs, rowsFailing, checksFaulted: faulted.length > 0, unmeasured };
}
