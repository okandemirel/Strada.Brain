/**
 * The scope gate's contracts (GDD-drift plan, M2 + M3).
 *
 * A milestone is green only when its own GDD rows, and every row that passed
 * before, pass checks the system owns, in one acceptance run the system
 * admits, on the committed revision. In a measured campaign six of six milestones
 * went green on prose: a worker's report, the verifier's flags, its own
 * tests. These are the shapes every part of the replacement shares — the
 * requirement ledger, the checks, the run, the judge's input and its verdict
 * — so the items that build it can be built apart.
 *
 * Types and pure constants only: nothing here reads a file, a clock or a
 * game's names.
 */

import type { ClaimKind } from "./gdd-claims.js";
import type { RunIntegrity, TerminalKey } from "../agents/autonomy/terminal-key.js";

// =============================================================================
// THE FLAG
// =============================================================================

/**
 * off:    today's behaviour; nothing is extracted, written, run or judged.
 * shadow: everything is measured and judged, and the verdict is recorded, but
 *         every decision stays today's.
 * on:     the verdict decides green.
 */
export const SCOPE_GATE_MODES = ["off", "shadow", "on"] as const;
export type ScopeGateMode = (typeof SCOPE_GATE_MODES)[number];

export const DEFAULT_SCOPE_GATE_MODE: ScopeGateMode = "off";

export const SCOPE_GATE_ENV = "CAMPAIGN_SCOPE_GATE";

/**
 * Exactly off, shadow or on; unset or empty is the default. Anything else is
 * off with a warning that names it: an unreadable value must never switch
 * enforcement on (it parks milestones and commits into the user's project),
 * and a typo in one setting must not stop the daemon from booting. "true" and
 * "1" are unreadable here on purpose — a boolean does not say which mode.
 */
export function parseScopeGateMode(raw: string | undefined): { mode: ScopeGateMode; warning?: string } {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return { mode: DEFAULT_SCOPE_GATE_MODE };
  if ((SCOPE_GATE_MODES as readonly string[]).includes(value)) return { mode: value as ScopeGateMode };
  return {
    mode: "off",
    warning: `${SCOPE_GATE_ENV}=${JSON.stringify((raw ?? "").slice(0, 40))} is not off, shadow or on — the scope gate stays off`,
  };
}

// =============================================================================
// THE SYSTEM'S OWN ACCEPTANCE TESTS
// =============================================================================

/**
 * Where the acceptance checks live in a Unity project, "/"-separated. Brain
 * owns every byte under it; lease write-back and lease deletion refuse it
 * (`isSystemOwnedCheckPath` in agents/multi/system-owned-path.ts re-exports
 * this and decides containment).
 */
export const ACCEPTANCE_DIR = "Assets/StradaAcceptance";

/** Every acceptance test the system writes lives in this namespace (`Strada.Acceptance.<Mid>`). */
export const ACCEPTANCE_TEST_NAMESPACE = "Strada.Acceptance";

/** The NUnit category on every acceptance fixture, so a run can select exactly them. */
export const ACCEPTANCE_TEST_CATEGORY = "StradaAcceptance";

/** A full NUnit test name (as `failedNames` carries it) that belongs to the system's acceptance tests. */
export function isAcceptanceTestName(fullName: string): boolean {
  const name = fullName.trim();
  return name.startsWith(`${ACCEPTANCE_TEST_NAMESPACE}.`) && name.length > ACCEPTANCE_TEST_NAMESPACE.length + 1;
}

// =============================================================================
// THE REQUIREMENT LEDGER
// =============================================================================

/**
 * rule:       a labelled rule or a normative sentence
 * constant:   one number the GDD fixes (the assertion is the system's)
 * range:      a bounded quantity (the assertion is the system's)
 * input:      something the player does (a tap, a drag, a press)
 * flow:       an order of states or screens
 * screen:     a screen that must exist and be reachable
 * claim:      a whole-game number measured at delivery (fps, boot time)
 * aspiration: a business or process goal (KPI, budget); excluded and disclosed
 * judgement:  look and feel with no number; disclosed, never blocks
 */
export const REQUIREMENT_KINDS = [
  "rule",
  "constant",
  "range",
  "input",
  "flow",
  "screen",
  "claim",
  "aspiration",
  "judgement",
] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

/**
 * open:        no passing check on the current revision yet
 * passing:     its check passed on the revision named in `last`
 * failing:     its check ran and failed
 * check-fault: the system's check could not be made to work; a person decides
 * unmeasured:  nothing could run its check (no runner, no editor)
 * excluded:    the GDD or the planner puts it out of scope, with the reason
 * waived:      a person waived it, with the reason
 */
export const REQUIREMENT_STATUSES = [
  "open",
  "passing",
  "failing",
  "check-fault",
  "unmeasured",
  "excluded",
  "waived",
] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

/**
 * extracted:    the deterministic extractor read it from the approved GDD
 * llm-added:    the add-only pass proposed it, with a verbatim GDD quote
 * audit-added:  the coverage audit named it, with a verbatim GDD quote
 * review-added: the independent review named it, with a verbatim GDD quote
 */
export type RequirementSource = "extracted" | "llm-added" | "audit-added" | "review-added";

/**
 * Bounds code parsed out of the GDD; the model never writes them. `range` has
 * at least one of `lo`/`hi` (inclusive unless marked exclusive); `exact` is
 * compared with a tolerance.
 */
export type RequirementBounds =
  | { kind: "exact"; value: number; tolerance: number; unit?: string }
  | { kind: "range"; lo?: number; hi?: number; loExclusive?: boolean; hiExclusive?: boolean; unit?: string };

/**
 * covered-section:   a milestone's `coveredSections` claims the row's heading or an ancestor
 * section-reference: the milestone prompt's `§N.N` references (milestones planned before coveredSections)
 * final-milestone:   claims are owned by the last planned milestone
 * time-box-split:    moved to a split-off milestone when its time box ran out
 */
export type OwnershipReason = "covered-section" | "section-reference" | "final-milestone" | "time-box-split";

export interface RowOwnership {
  milestoneId: string;
  reason: OwnershipReason;
  /** What matched: the heading, the `§` reference, the milestone it was split from. */
  detail?: string;
  atMs: number;
}

export interface RowWaiver {
  userId: string;
  atMs: number;
  reason: string;
}

/** What decides a row: a system-written test, a play-through scenario, or a delivery-time claim. */
export type AcceptanceCheckRef =
  | {
      kind: "test";
      /** The full NUnit name the system chose (inside ACCEPTANCE_TEST_NAMESPACE). */
      testName: string;
      /** Project-relative path of the acceptance file that holds it. */
      path: string;
      /** sha256 of the body the writer returned, before the system wrapped it. */
      bodySha: string;
      /** When a later test replaced this one (a changed GDD number, a rebind). */
      supersededAtMs?: number;
      /** Why the independent review called it weak; the row stays open until a regenerated test passes. */
      weak?: string;
    }
  | {
      kind: "scenario";
      /** The requirement text the play-through scenario is asked about. */
      requirement: string;
    }
  | {
      kind: "claim";
      /** The GDD number the delivery gate measures. */
      claimKind: ClaimKind;
    };

/**
 * pass / fail:  the check ran and said so
 * flaky:        failed, then passed on the one re-run — a check fault, not a pass
 * not-run:      expected and not in the run (its file did not compile, the run was cut)
 * check-fault:  the system's check is at fault, not the game
 * unmeasured:   nothing could run it
 */
export type RowOutcome = "pass" | "fail" | "flaky" | "not-run" | "check-fault" | "unmeasured";

export interface RowResult {
  /** The project revision this was measured on; a pass on another revision closes nothing here. */
  revision: string;
  runId?: string;
  atMs: number;
  outcome: RowOutcome;
  /** What the run said: the assertion message, the refusal, the compile error. */
  detail: string;
  /** Its check compiled in an earlier run: one that did and no longer does is a fail, not a check fault. */
  compiledBefore?: boolean;
  /**
   * The system's bytes the check last compiled from (its file and the
   * harness, hashed together). Only while the bytes in the project are still
   * these did it "compile before": a file the system rewrote since — revised,
   * regenerated, rebound, or a sibling rendered into it — answers for itself.
   */
  checkSha?: string;
  /**
   * The body sha of the check this row last passed with, carried while that
   * check stays its current one: a fail with it is a regression on every
   * later settle, not only on the run that found it.
   */
  passedWith?: string;
}

export interface RequirementRow {
  /** The requirement's identity (`requirement-identity.ts`, `req-<ordinal>-<fingerprint>`). */
  rid: string;
  /** `encodeRequirement(identity)`: the text with its identity tail, as the coverage queue stores it. */
  encoded: string;
  /** The GDD's own label, when it has one ("G-04", "FR-3"). */
  label?: string;
  /** The GDD's words, verbatim. */
  text: string;
  /** The innermost heading the row sits under, as the GDD spells it. */
  section: string;
  /** The heading path, outermost first; ownership by an ancestor heading reads it. */
  sectionPath?: string[];
  /** The heading's number ("7.4"), when it has one; matched against `§` references. */
  sectionNumber?: string;
  /** 1-based line in the approved GDD text. */
  line: number;
  /** Character offsets of `text` in the approved GDD text, end exclusive. */
  span: { start: number; end: number };
  kind: RequirementKind;
  source: RequirementSource;
  bounds?: RequirementBounds;
  /** The milestone that owns it now; absent while it is queued. */
  owner?: string;
  /** Every owner it has had, oldest first. */
  ownership: RowOwnership[];
  status: RequirementStatus;
  excludedBecause?: string;
  waiver?: RowWaiver;
  checks: AcceptanceCheckRef[];
  last?: RowResult;
  /** The approved GDD it was read from (`Campaign.gddSha256` / `gddRevision`). */
  gddSha256: string;
  gddRevision: number;
}

/** A numbered series the GDD defines only in part (a stated span "G-01 to G-07", four defined). Reported, never invented. */
export interface NumberingGap {
  series: string;
  missing: string[];
  detail: string;
}

/** Rows past the extraction caps: counted and disclosed as "not checked (cap)", never dropped silently. */
export interface RequirementOverflow {
  count: number;
  sections: string[];
}

export interface RequirementLedger {
  version: 1;
  gddSha256: string;
  gddRevision: number;
  extractedAtMs: number;
  rows: RequirementRow[];
  overflow: RequirementOverflow;
  numberingGaps: NumberingGap[];
  /** Rows the add-only LLM pass contributed (each quotes the GDD verbatim). */
  llmAdded: number;
  /**
   * The GDD revision the add-only pass last read. Behind `gddRevision` (an
   * amendment re-read the rows, or every call failed) means the pass is still
   * owed, and the next settle or revive runs it.
   */
  modelPassRevision?: number;
}

// =============================================================================
// THE CHECKS
// =============================================================================

/** Whether the check's writer is a model that did not work on the milestone. */
export type WriterIndependence = "different-model" | "same-model";

export interface AcceptanceWriter {
  provider: string;
  model: string;
  independence: WriterIndependence;
}

export interface AcceptanceTestRef {
  rid: string;
  testName: string;
  bodySha: string;
  /** Set when this test was written by another call than the file's (a regeneration, a rebind). */
  writer?: AcceptanceWriter;
  /**
   * The writer's parts as it returned them, before the system wrapped them.
   * A file holds every check of its milestone, so writing one new check
   * renders the file again from all of them; without these the checks
   * already in it could not be carried into the new bytes.
   */
  check?: AcceptanceCheckBody;
}

/** One acceptance file; the canonical bytes live in campaigns.db and are restored before every measurement. */
export interface AcceptanceSource {
  milestoneId: string;
  /** Project-relative, under ACCEPTANCE_DIR. */
  path: string;
  sha256: string;
  source: string;
  writer: AcceptanceWriter;
  /** How many times the system has rewritten this file. */
  revisions: number;
  tests: AcceptanceTestRef[];
}

/** A compile error the run attributed to an acceptance file (`error CS…` lines). */
export interface AcceptanceCompileError {
  readonly path: string;
  readonly line?: number;
  readonly code?: string;
  readonly message: string;
}

/**
 * Why a run was not admitted as evidence.
 *
 * no-runner:      no acceptance runner is wired
 * no-assembly:    no runtime assembly the acceptance assembly can reference
 * lock:           the project write lock was not acquired
 * no-record:      the run left no readable record
 * foreign-record: the record's run id or filter is not the one requested
 * count-mismatch: total ≠ the expected tests (a broken acceptance assembly shows up only here)
 * skipped:        the run skipped tests
 * tree-moved:     the revision changed while the run ran
 * runner-error:   the runner threw, or the editor was not available
 */
export type AcceptanceRefusalKind =
  | "no-runner"
  | "no-assembly"
  | "lock"
  | "no-record"
  | "foreign-record"
  | "count-mismatch"
  | "skipped"
  | "tree-moved"
  | "runner-error";

export interface AcceptanceRefusal {
  readonly kind: AcceptanceRefusalKind;
  readonly detail: string;
}

export interface AcceptanceRunResult {
  readonly admitted: boolean;
  readonly refusal?: AcceptanceRefusal;
  readonly runId?: string;
  /** The committed revision the run measured. */
  readonly revision: string;
  /** The full test names the run was asked for (OWN ∪ REG). */
  readonly expected: readonly string[];
  readonly total?: number;
  readonly failedNames: readonly string[];
  /** Failures the run counted that no name accounts for. Never read as passes. */
  readonly unattributed: number;
  readonly flaky: readonly string[];
  readonly acceptanceCompileErrors: readonly AcceptanceCompileError[];
  /** Acceptance files that differed from the stored bytes, and were restored. */
  readonly tamper: readonly string[];
  /** Failure messages parsed from the run's output, for prompts and the report only. */
  readonly failures: ReadonlyArray<{ readonly name: string; readonly message: string }>;
}

/** What runs a filtered acceptance batch under a ticket the campaign issued (unity_playmode_verify). */
export type AcceptanceSuiteRunner = (
  projectRoot: string,
  runId: string,
  filter: { readonly testFilter?: string; readonly categories?: string },
) => Promise<{ receipt?: string; detail?: string; content?: string }>;

// =============================================================================
// THE WRITER
// =============================================================================

export interface AcceptanceWriteContext {
  readonly milestoneId: string;
  /** Models that worked on the milestone; the writer must not be one of them while another is healthy. */
  readonly workerModels: readonly string[];
  /** What the system's test harness offers. */
  readonly harnessDoc: string;
  /** Public type and member signatures of the project, never bodies. */
  readonly surfaceDigest: string;
  /**
   * The most model calls this request may spend — the caller's remaining
   * per-milestone budget. The writer never exceeds it, nor its own cap; a row
   * it could not afford comes back faulted as "budget".
   */
  readonly maxCalls?: number;
  /** The ledger rows a file's tests check: repairCompile lints each repaired check against its row's kind and bounds. */
  readonly rows?: readonly RequirementRow[];
}

/** A test body as the writer returns it; the system wraps it (namespace, name, attributes, timeout). */
export interface AcceptanceCheckBody {
  readonly rid: string;
  readonly setup?: string;
  readonly act?: string;
  /** For constant and range rows: the expression whose value the system asserts against the row's bounds. */
  readonly observe?: string;
  readonly body?: string;
}

/** A row the writer could not observe through the public surface, and what would make it observable. */
export interface AcceptanceUnbound {
  readonly rid: string;
  readonly missingObservable: string;
}

/**
 * Why the writer returned no usable check for a row. None is the worker's
 * doing, so none is charged to the sprint.
 *
 * no-writer:   no healthy model could write at all
 * call-failed: the model call threw (an outage, not a fault of the check)
 * unparseable: the reply was not the strict JSON object, after the regeneration
 * missing:     the reply named the row neither in checks nor in unbound, after the regeneration
 * lint:        its check still broke a lint rule after the regeneration (`problems` say which)
 * budget:      the call budget ran out before the row was written
 * no-row:      a file's test names a row the caller did not pass
 */
export type AcceptanceWriteFaultCause = "no-writer" | "call-failed" | "unparseable" | "missing" | "lint" | "budget" | "no-row";

export interface AcceptanceWriteFault {
  readonly rid: string;
  readonly cause: AcceptanceWriteFaultCause;
  readonly problems: readonly string[];
}

export interface AcceptanceWriteResult {
  /** Every one passed `lintAcceptanceBody` against its row. */
  readonly checks: readonly AcceptanceCheckBody[];
  readonly unbound: readonly AcceptanceUnbound[];
  /** Rows that got neither a check nor an unbound answer. */
  readonly faulted: readonly AcceptanceWriteFault[];
  /**
   * The model that answered, and whether it worked on the milestone; when
   * several calls answered, the least independent of them. Absent when no
   * model answered (none was healthy, or no call could be afforded).
   */
  readonly writer?: AcceptanceWriter;
  /** Model calls this request spent, for the caller's per-milestone budget. */
  readonly calls: number;
  /** One sentence for the report when the writer is not independent of the workers, or nobody could write. */
  readonly disclosure?: string;
}

/**
 * The test writer. It sees the verbatim rows, the harness and the public
 * surface — never worker code, worker tests or worker reports.
 */
export interface AcceptanceAuthorLike {
  write(rows: readonly RequirementRow[], ctx: AcceptanceWriteContext): Promise<AcceptanceWriteResult>;
  regenerate(row: RequirementRow, problems: readonly string[], ctx: AcceptanceWriteContext): Promise<AcceptanceWriteResult>;
  repairCompile(
    file: AcceptanceSource,
    errors: readonly AcceptanceCompileError[],
    ctx: AcceptanceWriteContext,
  ): Promise<AcceptanceWriteResult>;
  rebind(row: RequirementRow, body: string, surface: string, ctx: AcceptanceWriteContext): Promise<AcceptanceWriteResult>;
  revise(
    row: RequirementRow,
    body: string,
    reason: string,
    failureMessage: string,
    ctx: AcceptanceWriteContext,
  ): Promise<AcceptanceWriteResult>;
  /** One line naming the configured writer, for status and the report. */
  describe(): string;
}

// =============================================================================
// THE JUDGE
// =============================================================================

/** red: charged after the first free bounce. unmeasurable: never charged. check-fault: the writer repairs it. */
export type ReasonClass = "red" | "unmeasurable" | "check-fault";

export type GreenReasonCode =
  | "compile-not-run"
  | "compile-failed"
  | "tamper"
  | "run-not-admitted"
  | "row-failing"
  | "regression"
  | "row-not-run"
  | "row-no-check"
  | "row-check-fault"
  | "row-flaky"
  | "row-unmeasured"
  | "row-unbound"
  | "terminal"
  | "gate-failed"
  | "prose-failure";

export interface GreenReason {
  readonly reasonClass: ReasonClass;
  readonly code: GreenReasonCode;
  /** One sentence for the report and the bounce text. */
  readonly detail: string;
  readonly rid?: string;
  readonly testName?: string;
  readonly terminal?: TerminalKey;
}

/** The four completion gates that already exist, by their milestone flag names. */
export type CompletionGate = "visualEvidence" | "noWork" | "art" | "prosOnly";

/** not-armed: the gate does not apply to this sprint (e.g. the planner never demanded a frame). */
export type GateOutcome = "pass" | "fail" | "not-armed";

/** proven: rows passed. vacuous: the milestone owns no rows and passed everything else. */
export type GreenBasis = "proven" | "vacuous";

/** Everything the pure judge reads; stored whole with each judgement so any verdict can be replayed. */
export interface GreenInput {
  readonly milestoneId: string;
  readonly mode: ScopeGateMode;
  /** The committed revision the measurement was taken on. */
  readonly revision: string;
  readonly compile: { readonly ran: boolean; readonly ok: boolean; readonly detail?: string };
  /** Acceptance files restored in this settle (before the commit, before the run). */
  readonly tamper: readonly string[];
  /** OWN: rows this milestone owns that a test decides (not excluded, waived, aspiration or judgement). */
  readonly own: readonly RequirementRow[];
  /** REG: rows that passed before and must still pass. */
  readonly regression: readonly RequirementRow[];
  /** This measurement's outcome per row id; a row absent here was not measured. */
  readonly results: Readonly<Record<string, RowResult>>;
  /** Absent when no run was attempted. */
  readonly run?: AcceptanceRunResult;
  /** Who wrote each check: `scopeProven` needs a different model on every OWN test. */
  readonly sources: readonly AcceptanceSource[];
  /**
   * How the run ended. `infrastructureErrors`, when the settle counted it, is
   * how many `error` keys the machinery threw; an `error` beyond that count
   * is the worker's own run failing, which is red (W01). Absent, every
   * `error` is read as the machinery's.
   */
  readonly integrity: RunIntegrity & { readonly infrastructureErrors?: number };
  readonly gates: Readonly<Record<CompletionGate, GateOutcome>>;
  /** The worker's result reads as a terminal failure; consulted only for a milestone that owns no rows. */
  readonly proseFailure: boolean;
  /**
   * OWN rows the test writer could not observe through the public surface,
   * with what would make them observable. `told`: an earlier verdict already
   * asked the worker to expose it, so a row still unbound now is red.
   */
  readonly unbound?: Readonly<Record<string, { readonly missingObservable: string; readonly told: boolean }>>;
}

export type Judgement =
  | { readonly green: true; readonly basis: GreenBasis; readonly caveats: readonly string[] }
  | { readonly green: false; readonly state: ReasonClass; readonly reasons: readonly GreenReason[] };

// =============================================================================
// WHAT A MILESTONE RECORDS
// =============================================================================

/** The last verdict the scope gate reached on a milestone (in shadow, recorded and not acted on). */
export interface ScopeVerdictRecord {
  green: boolean;
  state?: ReasonClass;
  basis?: GreenBasis;
  revision: string;
  runId?: string;
  reasons: GreenReason[];
  caveats?: string[];
  atMs: number;
  mode: ScopeGateMode;
}

/** A milestone whose budget ran out on failing rows: `failed`, rows queued, the ladder moves on. */
export interface ParkedRecord {
  atMs: number;
  reasons: GreenReason[];
  /** The row ids queued for later sprints. */
  queued: string[];
}

/** typed: judged on the carried terminal key and owned rows. legacy: went green before the gate existed. */
export type JudgementBasis = "typed" | "legacy";

/** The writer calls spent repairing this milestone's checks. */
export interface WriterRepairs {
  compile: number;
  rebinds: number;
  disputes: number;
}
