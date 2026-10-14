/**
 * What the scope gate's ledger and verdicts say, in words a person reads, and
 * the decisions only a person may make about them (GDD-drift plan W14).
 *
 * In a measured campaign six of six milestones went green on prose, and nothing a
 * person read — the delivery report, `/campaign` — said which GDD rows any of
 * them had been judged on. Here every milestone's rows are counted by status,
 * a parked milestone says so in its line, and each verdict names its basis and
 * who wrote its checks. A waiver is a person's: it is recorded with who and
 * why, and disclosed wherever the rows are.
 *
 * Pure apart from what the caller passes in: no file, clock, process or
 * storage of its own.
 */

import { isTerminalKey, worstTerminal, type RunIntegrity, type TerminalKey } from "../agents/autonomy/terminal-key.js";
import { decodeRequirement } from "./requirement-identity.js";
import { judgeMilestone, legacyRunIntegrity, rowDecides, type StampDecoder } from "./scope-verdict.js";
import type { Campaign, CampaignMilestone } from "./types.js";
import type {
  AcceptanceSource,
  CompletionGate,
  GateOutcome,
  GreenInput,
  Judgement,
  RequirementKind,
  RequirementLedger,
  RequirementRow,
  RowResult,
  ScopeGateMode,
  ScopeVerdictRecord,
} from "./scope-types.js";
import type { StoredJudgement } from "./campaign-storage.js";

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// =============================================================================
// ROWS
// =============================================================================

/**
 * Whether a row can hold a milestone back: the judge's own rule, called
 * rather than copied so the report cannot count a different set of rows from
 * the one the verdict weighs. A person's waiver, the plan's exclusion, an
 * aspiration and look and feel never block.
 */
export function rowBlocks(row: RequirementRow): boolean {
  return rowDecides(row);
}

/** The kinds a system-written acceptance test decides; claims are measured at delivery, the rest never block. */
export const TEST_ROW_KINDS: ReadonlySet<RequirementKind> = new Set(["rule", "constant", "range", "input", "flow", "screen"]);

/** The rows a milestone owns now (`RequirementRow.owner`), in ledger order. */
export function ownedRows(ledger: RequirementLedger | undefined, milestoneId: string): RequirementRow[] {
  return (ledger?.rows ?? []).filter((r) => r.owner === milestoneId);
}

/**
 * The rows the next acceptance file for this milestone is written from: owned,
 * decided by a test, and not taken out of judgement. A waived row's test is
 * not rendered again, so the next system commit of the file drops it.
 */
export function acceptanceTestRows(campaign: Pick<Campaign, "requirements">, milestoneId: string): RequirementRow[] {
  return ownedRows(campaign.requirements, milestoneId).filter((r) => rowBlocks(r) && TEST_ROW_KINDS.has(r.kind));
}

export interface RowCounts {
  readonly total: number;
  readonly passing: number;
  readonly failing: number;
  readonly checkFault: number;
  readonly unmeasured: number;
  readonly open: number;
  readonly waived: number;
  readonly excluded: number;
  /** Aspirations and look and feel: disclosed, never blocking. */
  readonly disclosed: number;
}

export function countRows(rows: readonly RequirementRow[]): RowCounts {
  const c = { total: rows.length, passing: 0, failing: 0, checkFault: 0, unmeasured: 0, open: 0, waived: 0, excluded: 0, disclosed: 0 };
  for (const row of rows) {
    if (row.status === "waived") c.waived++;
    else if (row.status === "excluded") c.excluded++;
    else if (!rowBlocks(row)) c.disclosed++;
    else if (row.status === "passing") c.passing++;
    else if (row.status === "failing") c.failing++;
    else if (row.status === "check-fault") c.checkFault++;
    else if (row.status === "unmeasured") c.unmeasured++;
    else c.open++;
  }
  return c;
}

/** "1 passing, 1 failing, 0 check-fault, 0 unmeasured, 0 waived (of 3; 1 open)": every status the plan names, zeros included. */
export function describeRowCounts(c: RowCounts): string {
  const rest = [
    c.open > 0 ? `${c.open} open` : "",
    c.excluded > 0 ? `${c.excluded} excluded` : "",
    c.disclosed > 0 ? `${c.disclosed} never block (look and feel, aspirations)` : "",
  ].filter((s) => s !== "");
  return (
    `${c.passing} passing, ${c.failing} failing, ${c.checkFault} check-fault, ${c.unmeasured} unmeasured, ${c.waived} waived` +
    ` (of ${c.total}${rest.length > 0 ? `; ${rest.join(", ")}` : ""})`
  );
}

/** The row as a reader finds it in the GDD: its label or id, and where it sits. */
export function rowRef(row: RequirementRow): string {
  return `${row.label ?? row.rid} (${row.sectionNumber ? `§${row.sectionNumber}` : row.section})`;
}

/** Blocking rows nobody owns: queued, and holding delivery until a sprint or a person settles them. */
export function queuedRows(ledger: RequirementLedger): RequirementRow[] {
  return ledger.rows.filter((r) => r.owner === undefined && rowBlocks(r));
}

/** The ledger as a whole, for the report and `/campaign rows`. */
export function ledgerLines(ledger: RequirementLedger): string[] {
  const lines = [
    `${ledger.rows.length} row(s) read from the approved GDD (${ledger.gddSha256.slice(0, 8)}, revision ${ledger.gddRevision}): ` +
      `${describeRowCounts(countRows(ledger.rows))}; queued with no owner: ${queuedRows(ledger).length}`,
  ];
  const aspirations = ledger.rows.filter((r) => r.kind === "aspiration").length;
  const looks = ledger.rows.filter((r) => r.kind === "judgement").length;
  if (aspirations + looks > 0) {
    lines.push(
      `${aspirations} aspiration row(s) (KPIs, budget, schedule) excluded and disclosed; ` +
        `${looks} look-and-feel row(s) disclosed, never blocking`,
    );
  }
  if (ledger.overflow.count > 0) {
    lines.push(
      `${ledger.overflow.count} row(s) past the extraction cap were NOT checked` +
        (ledger.overflow.sections.length > 0 ? ` (in ${clip(ledger.overflow.sections.join(", "), 160)})` : ""),
    );
  }
  for (const gap of ledger.numberingGaps.slice(0, 5)) {
    lines.push(`numbering gap in ${gap.series}: ${clip(gap.missing.join(", "), 120)} — not in the GDD, so not invented (${clip(gap.detail, 120)})`);
  }
  if (ledger.llmAdded > 0) lines.push(`${ledger.llmAdded} row(s) added by the add-only pass, each quoting the GDD verbatim`);
  const waived = ledger.rows.filter((r) => r.status === "waived");
  for (const row of waived.slice(0, 10)) {
    lines.push(
      `waived by a person: ${rowRef(row)} — "${clip(row.waiver?.reason ?? "no reason recorded", 160)}"` +
        (row.waiver ? ` (${row.waiver.userId}, ${new Date(row.waiver.atMs).toISOString().slice(0, 10)})` : ""),
    );
  }
  if (waived.length > 10) lines.push(`…and ${waived.length - 10} more waived row(s) — \`/campaign rows\``);
  const faults = ledger.rows.filter((r) => r.status === "check-fault");
  if (faults.length > 0) {
    lines.push(
      `${faults.length} row(s) whose system-written check could not be made to work — a person decides: ` +
        clip(faults.slice(0, 8).map(rowRef).join(", "), 240),
    );
  }
  return lines;
}

// =============================================================================
// VERDICTS
// =============================================================================

/** The scope gate's last verdict on a milestone, in one sentence; a shadow verdict says it decided nothing. */
export function describeScopeVerdict(v: ScopeVerdictRecord): string {
  const how = v.mode === "shadow" ? "scope gate (shadow, not acted on)" : `scope gate (${v.mode})`;
  const on = v.revision ? ` on ${v.revision.slice(0, 8)}` : "";
  if (v.green) return `${how}: green${on} (${v.basis ?? "basis not recorded"})`;
  const first = v.reasons[0];
  return (
    `${how}: ${v.mode === "shadow" ? "would NOT be green" : "NOT green"}${on} — ${v.state ?? "class not recorded"}` +
    (first ? `: ${clip(first.detail, 160)}` : "") +
    (v.reasons.length > 1 ? ` (+${v.reasons.length - 1} more)` : "")
  );
}

/** Each distinct writer of a milestone's checks: "provider:model (independence)". */
function writersOf(sources: readonly AcceptanceSource[]): Array<{ name: string; sameModel: boolean }> {
  const seen = new Map<string, boolean>();
  for (const file of sources) {
    for (const w of [file.writer, ...file.tests.map((t) => t.writer)]) {
      if (!w) continue;
      seen.set(`${w.provider}:${w.model} (${w.independence})`, w.independence === "same-model");
    }
  }
  return [...seen].map(([name, sameModel]) => ({ name, sameModel }));
}

export interface MilestoneScopeReport {
  /** The park marker, which leads the milestone's line: a park is not a status of its own. */
  readonly lead?: string;
  /** Short marks for the milestone's line. */
  readonly marks: string[];
  /** Sentences for "how these greens were reached". */
  readonly caveats: string[];
}

/**
 * What the delivery report says about one milestone's scope: its rows, a
 * park, its basis, its checks' writer and the gate's verdict. Empty for a
 * milestone the gate never saw, so a campaign without a ledger reads as before.
 */
export function milestoneScopeReport(
  campaign: Pick<Campaign, "requirements">,
  m: CampaignMilestone,
  sources: readonly AcceptanceSource[],
): MilestoneScopeReport {
  const marks: string[] = [];
  const caveats: string[] = [];
  let lead: string | undefined;
  if (m.parked) {
    lead = `PARKED — ${m.parked.queued.length} row(s) queued for later sprints`;
    caveats.push(
      `${m.title}: parked when its budget ran out — ` +
        (m.parked.reasons.length > 0 ? m.parked.reasons.slice(0, 3).map((r) => clip(r.detail, 200)).join("; ") : "no reason recorded") +
        (m.parked.reasons.length > 3 ? ` (+${m.parked.reasons.length - 3} more)` : ""),
    );
  }
  if (campaign.requirements) {
    const rows = ownedRows(campaign.requirements, m.id);
    marks.push(rows.length > 0 ? `GDD rows: ${describeRowCounts(countRows(rows))}` : "owns no GDD rows");
  }
  if (m.judgementBasis === "legacy") {
    marks.push("basis: legacy");
    if (m.status === "green") caveats.push(`${m.title}: went green before the scope gate existed — its GDD rows were not judged then`);
  } else if (m.scopeVerdict?.green === true && m.scopeVerdict.basis) {
    marks.push(`basis: ${m.scopeVerdict.basis}`);
  }
  const writers = writersOf(sources);
  if (writers.length > 0) marks.push(`checks by ${writers.map((w) => w.name).join(", ")}`);
  for (const w of writers.filter((x) => x.sameModel)) {
    caveats.push(
      `${m.title}: its checks were written by ${w.name.replace(/ \(same-model\)$/, "")}, the same model that worked on it — ` +
        "a pass shows the rows hold, not that someone else checked them",
    );
  }
  const v = m.scopeVerdict;
  if (v) {
    marks.push(describeScopeVerdict(v));
    const prefix = `${m.title}: scope gate${v.mode === "shadow" ? " (shadow, not acted on)" : ""}`;
    if (v.green) {
      for (const c of v.caveats ?? []) caveats.push(`${prefix}: ${clip(c, 300)}`);
    } else if (v.reasons.length > 0) {
      caveats.push(
        `${prefix}: ${v.reasons.slice(0, 3).map((r) => clip(r.detail, 240)).join("; ")}` +
          (v.reasons.length > 3 ? ` (+${v.reasons.length - 3} more)` : ""),
      );
    }
  }
  return { ...(lead ? { lead } : {}), marks, caveats };
}

/** The campaign-wide block of the delivery report; empty for a campaign the gate never saw. */
export function campaignScopeBlock(campaign: Pick<Campaign, "requirements" | "requirementsUnreadable">, mode: ScopeGateMode): string[] {
  if (campaign.requirementsUnreadable === true) {
    return ["⚠️ The GDD's requirement ledger could not be read — no GDD row is reported here, and none was proven."];
  }
  if (campaign.requirements) {
    return ["**GDD requirement rows:**", ...ledgerLines(campaign.requirements).map((l) => `- ${l}`)];
  }
  if (mode !== "off") {
    return [`Scope gate ${mode}: this campaign has no requirement ledger yet, so no milestone was judged on its GDD rows.`];
  }
  return [];
}

// =============================================================================
// /campaign rows
// =============================================================================

const ROWS_LISTED = 30;

function rowLine(row: RequirementRow): string {
  const test = row.checks.find((c) => c.kind === "test" && c.supersededAtMs === undefined);
  const parts = [`• ${row.label ?? row.rid} · ${row.sectionNumber ? `§${row.sectionNumber}` : clip(row.section, 40)} · ${row.status} — "${clip(row.text, 140)}"`];
  if (test?.kind === "test") parts.push(`test \`${test.testName}\`${test.weak ? ` (called weak: ${clip(test.weak, 80)})` : ""}`);
  if (row.last) parts.push(`last: ${row.last.outcome} on ${row.last.revision.slice(0, 8)}: ${clip(row.last.detail, 160)}`);
  if (row.status === "waived") parts.push(`waived by ${row.waiver?.userId ?? "?"}: ${clip(row.waiver?.reason ?? "no reason recorded", 160)}`);
  if (row.status === "excluded" && row.excludedBecause) parts.push(`excluded: ${clip(row.excludedBecause, 120)}`);
  return parts.join(" · ");
}

/**
 * `/campaign rows [milestone]`: the ledger by milestone, or one milestone's
 * rows with their tests and last results. `queued` lists the rows nobody owns.
 */
export function formatRows(
  campaign: Pick<Campaign, "id" | "milestones" | "requirements" | "requirementsUnreadable">,
  opts: { milestoneId?: string; mode: ScopeGateMode },
): string {
  if (campaign.requirementsUnreadable === true) {
    return `⚠️ Campaign \`${campaign.id}\`: the requirement ledger could not be read — no row can be listed.`;
  }
  const ledger = campaign.requirements;
  if (!ledger) {
    return `Campaign \`${campaign.id}\` has no requirement ledger yet — no GDD row is tracked (scope gate ${opts.mode}).`;
  }
  const wanted = opts.milestoneId?.trim().toLowerCase();
  if (!wanted) {
    const lines = [`📋 *GDD rows* — campaign \`${campaign.id}\``, ...ledgerLines(ledger), ""];
    for (const m of campaign.milestones) {
      const rows = ownedRows(ledger, m.id);
      lines.push(
        `• ${m.id} ${m.title}${m.parked ? " (PARKED)" : ""} — ${rows.length > 0 ? describeRowCounts(countRows(rows)) : "owns no GDD rows"}`,
      );
    }
    lines.push("", "`/campaign rows <milestone>` lists one milestone's rows; `/campaign rows queued` the rows nobody owns.");
    return lines.join("\n");
  }
  let title: string;
  let rows: RequirementRow[];
  if (wanted === "queued") {
    title = "queued with no owner";
    rows = queuedRows(ledger);
  } else {
    const m = campaign.milestones.find((x) => x.id.toLowerCase() === wanted);
    if (!m) {
      return `Campaign \`${campaign.id}\` has no milestone ${opts.milestoneId} — its milestones are ${campaign.milestones.map((x) => x.id).join(", ")}.`;
    }
    title = `${m.id} ${m.title}${m.parked ? " (PARKED)" : ""}`;
    rows = ownedRows(ledger, m.id);
  }
  const lines = [`📋 *GDD rows* — ${title}: ${rows.length > 0 ? describeRowCounts(countRows(rows)) : "none"}`];
  for (const row of rows.slice(0, ROWS_LISTED)) lines.push(rowLine(row));
  if (rows.length > ROWS_LISTED) lines.push(`…and ${rows.length - ROWS_LISTED} more.`);
  return lines.join("\n");
}

// =============================================================================
// WAIVERS
// =============================================================================

/** "G-04", "g04" and "G4" are one label. */
function labelKey(label: string): string {
  return label.toUpperCase().replace(/[\s_-]+/g, "").replace(/(\D)0+(?=\d)/g, "$1");
}

/**
 * The rows a waiver names: `§7.4` is that section and every subsection under
 * it; otherwise a row id or the GDD's own label. Nothing is guessed — a target
 * that matches nothing waives nothing.
 */
export function rowsNamedBy(ledger: RequirementLedger, target: string): { rows: RequirementRow[]; how: string } {
  const t = target.trim();
  const section = /^§\s*(\d+(?:\.\d+)*)\.?$/u.exec(t);
  if (section) {
    const n = section[1]!;
    return {
      rows: ledger.rows.filter((r) => r.sectionNumber !== undefined && (r.sectionNumber === n || r.sectionNumber.startsWith(`${n}.`))),
      how: `section §${n}`,
    };
  }
  const byId = ledger.rows.filter((r) => r.rid.toLowerCase() === t.toLowerCase());
  if (byId.length > 0) return { rows: byId, how: `row ${byId[0]!.rid}` };
  const key = labelKey(t);
  return { rows: key === "" ? [] : ledger.rows.filter((r) => r.label !== undefined && labelKey(r.label) === key), how: `label ${t}` };
}

/** Which identities a row answers to in the coverage queue: its id, and its lineage across rewordings. */
function identitiesOf(row: RequirementRow): string[] {
  const identity = decodeRequirement(row.encoded).identity;
  return [row.rid, ...(identity ? [identity.id, identity.lineage] : [])];
}

/**
 * Drop every queued coverage gap that is a waived row: a queued requirement
 * schedules a sprint and holds delivery, and a person said this one does not.
 * Returns how many entries were dropped.
 */
export function dequeueWaived(campaign: Pick<Campaign, "requirements" | "pendingCoverageGaps">): number {
  const queue = campaign.pendingCoverageGaps;
  const waived = (campaign.requirements?.rows ?? []).filter((r) => r.status === "waived");
  if (!queue || queue.length === 0 || waived.length === 0) return 0;
  const ids = new Set(waived.flatMap(identitiesOf));
  const kept = queue.filter((gap) => {
    const identity = decodeRequirement(gap).identity;
    return identity === undefined || (!ids.has(identity.id) && !ids.has(identity.lineage));
  });
  const dropped = queue.length - kept.length;
  if (dropped > 0) campaign.pendingCoverageGaps = kept;
  return dropped;
}

/**
 * Keep a person's waivers through a save from a copy that was read before
 * them: the settle path holds its campaign across long awaits, and its save
 * would otherwise put the row back to failing and back in the queue.
 */
export function carryWaivers(stored: RequirementLedger | undefined, saving: Pick<Campaign, "requirements" | "pendingCoverageGaps">): void {
  const rows = saving.requirements?.rows;
  if (!stored || !rows) return;
  const waived = new Map(stored.rows.filter((r) => r.status === "waived" && r.waiver).map((r) => [r.rid, r]));
  if (waived.size === 0) return;
  for (const row of rows) {
    const decided = waived.get(row.rid);
    if (decided && row.status !== "waived") {
      row.status = "waived";
      row.waiver = decided.waiver;
    }
  }
  dequeueWaived(saving);
}

export interface WaiverOutcome {
  readonly how: string;
  readonly waived: RequirementRow[];
  /** Matched, and already out of judgement: waived before, or excluded by the plan with its own reason. */
  readonly untouched: RequirementRow[];
  readonly dequeued: number;
}

/** Mark the named rows waived by `userId`, for `reason`, and take them out of the coverage queue. */
export function applyWaiver(
  campaign: Pick<Campaign, "requirements" | "pendingCoverageGaps">,
  request: { target: string; reason: string; userId: string; atMs: number },
): WaiverOutcome {
  const ledger = campaign.requirements;
  if (!ledger) return { how: request.target, waived: [], untouched: [], dequeued: 0 };
  const { rows, how } = rowsNamedBy(ledger, request.target);
  const waived: RequirementRow[] = [];
  const untouched: RequirementRow[] = [];
  for (const row of rows) {
    if (row.status === "waived" || row.status === "excluded") {
      untouched.push(row);
      continue;
    }
    row.status = "waived";
    row.waiver = { userId: request.userId, atMs: request.atMs, reason: request.reason };
    waived.push(row);
  }
  return { how, waived, untouched, dequeued: dequeueWaived(campaign) };
}

// =============================================================================
// /campaign rejudge
// =============================================================================

/** A milestone's lineage tip as the task manager holds it. */
export interface RecordedTip {
  readonly status: string;
  readonly result?: string | null;
  readonly verification?: { readonly runIntegrity?: RunIntegrity } | null;
}

export interface RejudgeDeps {
  /** Every stored verdict of the campaign, oldest first. */
  readonly judgements: readonly StoredJudgement[];
  readonly sources: readonly AcceptanceSource[];
  readonly tipOf: (m: CampaignMilestone) => RecordedTip | undefined;
  readonly stampsIn: StampDecoder;
  /** The worker's result reads as a terminal failure (consulted only for a milestone that owns no rows). */
  readonly proseFailure: (text: string) => boolean;
  readonly mode: ScopeGateMode;
}

export interface RejudgedMilestone {
  readonly id: string;
  readonly title: string;
  readonly stored: CampaignMilestone["status"];
  readonly parked: boolean;
  /** Absent when the milestone never settled, so there is nothing to judge. */
  readonly judgement?: Judgement;
  readonly from?: "stored" | "record";
  readonly storedAtMs?: number;
  /** For a stored verdict: whether replaying its stored input gives the same verdict. */
  readonly agrees?: boolean;
  /** Why it was not judged. */
  readonly note?: string;
}

/** Rows measured on any recorded revision never match it, so a rebuilt verdict reads them as not measured here. */
const UNRECORDED_REVISION = "an unrecorded revision";

/** How a recorded run ended: the carried key, else the system's stamps — and a run that did not complete did not finish clean. */
function recordedIntegrity(tip: RecordedTip | undefined, stampsIn: StampDecoder): RunIntegrity | undefined {
  if (!tip) return undefined;
  const carried = tip.verification?.runIntegrity;
  if (carried && isTerminalKey(carried.worst)) return carried;
  const legacy = legacyRunIntegrity(tip.result, stampsIn);
  const settled: TerminalKey | undefined =
    tip.status === "cancelled" ? "interrupted" : tip.status === "failed" || tip.status === "blocked" ? "error" : undefined;
  if (settled === undefined) return legacy;
  const keys = [...legacy.terminalKeys.filter((k) => k !== "done"), settled];
  return { ...legacy, terminalKeys: keys, worst: worstTerminal(keys) ?? settled };
}

/**
 * The four completion gates as the milestone recorded them. A gate that
 * bounced the sprint and recorded no later outcome has none — the old code
 * let the second completion stand either way — and one that never bounced it
 * let it through.
 */
function recordedGates(m: CampaignMilestone): Record<CompletionGate, GateOutcome> {
  const gates: Partial<Record<CompletionGate, GateOutcome>> = {};
  if (m.visualEvidence === "observed") gates.visualEvidence = "pass";
  else if (m.visualEvidence === "none-gate-not-demanded") gates.visualEvidence = "not-armed";
  else if (m.visualEvidence === "none-gate-spent") gates.visualEvidence = "fail";
  else if (m.visualEvidenceBounced !== true) gates.visualEvidence = "pass";
  if (m.noWorkBounced !== true) gates.noWork = "pass";
  if (m.artBounced !== true) gates.art = "pass";
  if (m.prosOnlyBounced !== true) gates.prosOnly = "pass";
  // A missing gate is no recorded outcome, which the judge reads as not passed.
  return gates as Record<CompletionGate, GateOutcome>;
}

/** The judge's input rebuilt from what the campaign and its tasks recorded, for a milestone settled before verdicts were stored. */
function inputFromRecord(campaign: Campaign, index: number, deps: RejudgeDeps): GreenInput {
  const m = campaign.milestones[index]!;
  const own = ownedRows(campaign.requirements, m.id);
  const earlier = new Set(campaign.milestones.slice(0, index).map((x) => x.id));
  const regression = (campaign.requirements?.rows ?? []).filter((r) => r.owner !== undefined && earlier.has(r.owner) && r.status === "passing");
  const results: Record<string, RowResult> = {};
  for (const row of [...own, ...regression]) if (row.last) results[row.rid] = row.last;
  const tip = deps.tipOf(m);
  const c = m.compileVerdict;
  return {
    milestoneId: m.id,
    mode: deps.mode,
    revision: UNRECORDED_REVISION,
    compile: c
      ? { ran: c.ran, ok: c.ran && c.ok && c.refused === undefined, ...(c.detail || c.refused ? { detail: c.refused ?? c.detail } : {}) }
      : { ran: false, ok: false, detail: "no compile verdict was recorded for this milestone" },
    tamper: [],
    own,
    regression,
    results,
    sources: deps.sources.filter((s) => s.milestoneId === m.id),
    // Unknown is not a clean finish: the judge reads a missing record as unmeasurable.
    integrity: recordedIntegrity(tip, deps.stampsIn) as RunIntegrity,
    gates: recordedGates(m),
    proseFailure: tip?.status === "completed" && deps.proseFailure(tip.result ?? ""),
  };
}

function sameVerdict(a: Judgement, b: Judgement): boolean {
  if (a.green !== b.green) return false;
  return a.green ? a.basis === (b as typeof a).basis : a.state === (b as typeof a).state;
}

/**
 * Judge every settled milestone again, changing nothing: from its newest
 * stored verdict's input when there is one, else from what the campaign and
 * its tasks recorded.
 */
export function rejudgeCampaign(campaign: Campaign, deps: RejudgeDeps): RejudgedMilestone[] {
  const newest = new Map<string, StoredJudgement>();
  for (const j of deps.judgements) newest.set(j.milestoneId, j);
  return campaign.milestones.map((m, index) => {
    const base = { id: m.id, title: m.title, stored: m.status, parked: m.parked !== undefined };
    const stored = newest.get(m.id);
    if (stored?.input) {
      const judgement = judgeMilestone(stored.input);
      return { ...base, judgement, from: "stored" as const, storedAtMs: stored.atMs, agrees: sameVerdict(judgement, stored.judgement) };
    }
    if (m.status !== "green" && m.status !== "failed") {
      return { ...base, note: `${m.status}: never settled, nothing to judge` };
    }
    const note = stored?.unreadable ? `its stored verdict cannot be replayed (${clip(stored.unreadable, 120)}); rebuilt from the record` : undefined;
    return { ...base, judgement: judgeMilestone(inputFromRecord(campaign, index, deps)), from: "record" as const, ...(note ? { note } : {}) };
  });
}

/** `/campaign rejudge`: one line per milestone and, first, how many stored greens would stand. */
export function formatRejudge(campaign: Pick<Campaign, "id">, judged: readonly RejudgedMilestone[]): string {
  const greens = judged.filter((j) => j.stored === "green");
  const standing = greens.filter((j) => j.judgement?.green === true).length;
  const replayed = judged.filter((j) => j.from === "stored").length;
  const rebuilt = judged.filter((j) => j.from === "record").length;
  const lines = [
    `⚖️ *Re-judged* \`${campaign.id}\` — read-only: nothing was stored, sent or changed`,
    `**${standing} of ${greens.length} stored greens would be green under the scope gate** ` +
      `(${replayed} replayed from stored verdicts, ${rebuilt} rebuilt from the record)`,
  ];
  for (const j of judged) {
    const was = `${j.stored}${j.parked ? " (PARKED)" : ""}`;
    if (!j.judgement) {
      lines.push(`• ${j.id} ${j.title} — ${was}: not judged (${j.note ?? "no reason recorded"})`);
      continue;
    }
    const verdict = j.judgement.green ? `green (${j.judgement.basis})` : `NOT green (${j.judgement.state})`;
    const from =
      j.from === "stored"
        ? `replayed from the verdict stored ${new Date(j.storedAtMs ?? 0).toISOString()}: ${j.agrees ? "the replay agrees" : "the replay DIFFERS from the stored verdict"}`
        : "rebuilt from the record";
    const why = j.judgement.green
      ? j.judgement.caveats.length > 0
        ? `: ${clip(j.judgement.caveats[0]!, 200)}`
        : ""
      : `: ${clip(j.judgement.reasons[0]?.detail ?? "no reason recorded", 220)}${j.judgement.reasons.length > 1 ? ` (+${j.judgement.reasons.length - 1} more)` : ""}`;
    lines.push(`• ${j.id} ${j.title} — stored ${was} → ${verdict}, ${from}${why}${j.note ? ` [${j.note}]` : ""}`);
  }
  if (rebuilt > 0) {
    lines.push(
      "",
      "A verdict rebuilt from the record reads how the run ended from the carried key or the system's own stamps, the compile and " +
        "gate outcomes the milestone recorded, and the ledger's rows; an outcome nobody recorded is not a pass.",
    );
  }
  return lines.join("\n");
}
