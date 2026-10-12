/**
 * A campaign's requirement ledger over its life (GDD-drift plan W11): read
 * once from the APPROVED text, completed by the add-only model pass once per
 * revision, and read again when a person amends the GDD.
 *
 * requirement-rows.ts reads rows from a text; this is what a campaign does
 * with them. Every function takes the text, the ladder and the clock from its
 * caller — none reads a file, so none can reach the copy on disk that workers
 * edit and `gddTextOf` prefers.
 */

import {
  assignOwners,
  extractRequirementRows,
  isPlannedMilestone,
  PLAN_EXCLUSION_PREFIX,
  proposeRowsAddOnly,
  requirementLedgerFrom,
  type CompleteText,
  type OwnerCandidate,
} from "./requirement-rows.js";
import {
  contentFingerprint,
  decodeRequirement,
  encodeRequirement,
  type RequirementIdentity,
} from "./requirement-identity.js";
import { ledgerLines, rowRef } from "./scope-report.js";
import type { RequirementKind, RequirementLedger, RequirementRow } from "./scope-types.js";
import type { Campaign, CampaignMilestone } from "./types.js";

export interface LedgerReadOptions {
  readonly atMs: number;
  /** CAMPAIGN_MAX_REQUIREMENT_ROWS. */
  readonly maxRows?: number;
  /** The planner's exclusions, "<item>: <the GDD's reason>" (`Campaign.planCoverage.excluded`). */
  readonly excluded?: readonly string[];
}

interface GddRef {
  readonly gddSha256: string;
  readonly gddRevision: number;
}

function ownRows(rows: readonly RequirementRow[], milestones: readonly OwnerCandidate[], options: LedgerReadOptions): RequirementRow[] {
  return assignOwners(rows, milestones, { excluded: options.excluded ?? [], atMs: options.atMs }).rows;
}

/**
 * Each planned milestone's rows, read off the rows' own `owner`, so the two
 * can never disagree. Coverage sprints and the final proof are left alone:
 * they were not planned to build a section, and what they work on is recorded
 * by the code that appends them.
 */
export function syncRequirementIds(milestones: CampaignMilestone[], rows: readonly RequirementRow[]): void {
  for (const milestone of milestones) {
    if (!isPlannedMilestone(milestone.id)) continue;
    milestone.requirementIds = rows.filter((r) => r.owner === milestone.id).map((r) => r.rid);
  }
}

/**
 * A cosmetic rewording is the row a running prompt showed, under a new id
 * (`LedgerAmendment.renamed`), so the attempt stays judged on it. A changed
 * ask or a new row keeps no such link: that prompt never showed it.
 */
export function carryPromptedIds(milestones: CampaignMilestone[], renamed: ReadonlyMap<string, string>): void {
  if (renamed.size === 0) return;
  for (const milestone of milestones) {
    if (milestone.promptedRequirementIds === undefined) continue;
    milestone.promptedRequirementIds = milestone.promptedRequirementIds.map((rid) => renamed.get(rid) ?? rid);
  }
}

/**
 * The rows owned by a NEW ladder. A replan under an existing ledger reuses the
 * ids m1…mN for different sprints, so an owner from the old ladder would claim
 * rows for a sprint that never planned them, and an exclusion from the old
 * plan would keep a row out of judgement that the new plan builds. Both are
 * decided again; the ownership history, results, tests and waivers stay.
 */
export function reownLedger(
  ledger: RequirementLedger,
  milestones: readonly OwnerCandidate[],
  options: LedgerReadOptions,
): RequirementLedger {
  const released = ledger.rows.map(({ owner: _owner, ...row }): RequirementRow => {
    if (row.status !== "excluded" || !row.excludedBecause?.startsWith(PLAN_EXCLUSION_PREFIX)) return row;
    const { excludedBecause: _why, ...rest } = row;
    return { ...rest, status: "open" };
  });
  return { ...ledger, rows: ownRows(released, milestones, options) };
}

/**
 * A campaign that ran before the ledger already names some of its
 * requirements: the coverage queue and the repair sprints. A row that IS one
 * of them — the same content, by the identity layer's own cosmetic rule —
 * takes that requirement's identity instead of a fresh one, so `gapKey` reads
 * the two as one and the repairs it already had count against it.
 *
 * Only an entry that carries an identity can be adopted; a legacy wording has
 * none, and `restoreLegacyWordings` maps it when a row is queued. The queue is
 * never rewritten, and an entry that merely shares a subject ("Shop: absent")
 * is a different finding, not the same requirement.
 */
export function adoptInFlightIdentities(
  rows: readonly RequirementRow[],
  inFlight: readonly string[],
  gdd: GddRef,
): { rows: RequirementRow[]; adopted: number } {
  const known = new Map<string, RequirementIdentity>();
  for (const raw of inFlight) {
    const identity = decodeRequirement(raw).identity;
    if (identity === undefined) continue;
    const key = contentFingerprint(identity.text);
    if (!known.has(key)) known.set(key, identity);
  }
  if (known.size === 0) return { rows: [...rows], adopted: 0 };
  let adopted = 0;
  const out = rows.map((row) => {
    const key = contentFingerprint(row.text);
    const identity = known.get(key);
    // An id another row already holds would make two rows one: rids key results, budgets and waivers.
    if (identity === undefined || rows.some((other) => other !== row && other.rid === identity.id)) return row;
    known.delete(key);
    adopted += 1;
    return {
      ...row,
      rid: identity.id,
      encoded: encodeRequirement({ ...identity, text: row.text, gddSha256: gdd.gddSha256, gddRevision: gdd.gddRevision }),
    };
  });
  return { rows: out, adopted };
}

/**
 * The first ledger of a campaign: the approved text's rows, the in-flight
 * identities adopted, each row given its owner. Undefined when the campaign
 * holds no approved text — the disk copy is never a substitute.
 */
export function buildLedger(
  campaign: Pick<Campaign, "gddText" | "gddSha256" | "gddRevision">,
  milestones: readonly OwnerCandidate[],
  options: LedgerReadOptions & { readonly inFlight?: readonly string[] },
): { ledger: RequirementLedger; adopted: number } | undefined {
  const read = requirementLedgerFrom(campaign, {
    atMs: options.atMs,
    ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
  });
  if (read === undefined) return undefined;
  const { rows, adopted } = adoptInFlightIdentities(read.rows, options.inFlight ?? [], read);
  return { ledger: { ...read, rows: ownRows(rows, milestones, options) }, adopted };
}

export interface LedgerAmendment {
  readonly ledger: RequirementLedger;
  /** The same wording: the same row. */
  readonly unchanged: number;
  /** Reworded with the same content: its result, test, owner and waiver carried. */
  readonly cosmetic: number;
  /** Each cosmetic rewording's old id → its new one. */
  readonly renamed: ReadonlyMap<string, string>;
  /** Reworded with a changed ask — a number, a clause: open again, its test superseded. */
  readonly reopened: RequirementRow[];
  /** Reworded with a changed ask under a heading the plan excludes: still out of judgement, so not reopened. */
  readonly changedExcluded: number;
  /** Reopened rows a person had waived: the waiver was for the old ask. */
  readonly waiversDropped: RequirementRow[];
  readonly added: number;
  /** Rows no code reads (model, audit or review added) whose quote the amended document still holds. */
  readonly kept: number;
  /** Rows the amended document no longer has. */
  readonly retired: RequirementRow[];
}

const headingsOf = (row: RequirementRow): string => [...(row.sectionPath ?? []), row.section].join("\u0000");

/**
 * The owner stays only where the row still sits: a rule moved to another
 * section is owned by whoever plans that section, while one that stayed keeps
 * an owner the ownership pass would not find again (a time-box split).
 */
function ownerCarried(row: RequirementRow, previous: RequirementRow): Partial<RequirementRow> {
  return {
    ...(headingsOf(row) === headingsOf(previous) && previous.owner !== undefined ? { owner: previous.owner } : {}),
    ownership: previous.ownership,
  };
}

function carried(row: RequirementRow, previous: RequirementRow): RequirementRow {
  return {
    ...row,
    ...ownerCarried(row, previous),
    // The plan's exclusion is applied again by the ownership pass; the row's own kind decides the rest.
    status: row.status === "excluded" || previous.status === "excluded" ? row.status : previous.status,
    ...(previous.waiver === undefined ? {} : { waiver: previous.waiver }),
    checks: previous.checks,
    ...(previous.last === undefined ? {} : { last: previous.last }),
  };
}

function reopenedFrom(row: RequirementRow, previous: RequirementRow, atMs: number): RequirementRow {
  return {
    ...row,
    ...ownerCarried(row, previous),
    // Kept, so the writer knows a test exists to replace; superseded, so it decides nothing.
    checks: previous.checks.map((c) => (c.kind === "test" && c.supersededAtMs === undefined ? { ...c, supersededAtMs: atMs } : c)),
  };
}

/** A row no code would read again (model, audit or review added) whose quote is still in the document, bound to the new revision. */
function rebound(row: RequirementRow, text: string, at: number, gdd: GddRef): RequirementRow {
  const identity = decodeRequirement(row.encoded).identity;
  return {
    ...row,
    encoded:
      identity === undefined
        ? row.encoded
        : encodeRequirement({ ...identity, text: row.text, gddSha256: gdd.gddSha256, gddRevision: gdd.gddRevision }),
    line: text.slice(0, at).split("\n").length,
    span: { start: at, end: at + row.text.length },
    gddSha256: gdd.gddSha256,
    gddRevision: gdd.gddRevision,
  };
}

/**
 * The ledger read again from an amended document (plan M5). Identities come
 * from `reconcileRequirements` through the extractor:
 *
 *   • the same wording is the same row, unchanged;
 *   • a COSMETIC rewording (identical content tokens) is the row reworded:
 *     its result, test, owner and waiver are carried to the new id, which
 *     supersedes the old one in the same lineage;
 *   • a rewording that changed the ask — a number, an added clause — keeps
 *     the lineage and nothing else: it is open again, its last result gone,
 *     its test kept but superseded, and a waiver given for the old ask no
 *     longer applies (a person decides again);
 *   • a row the document no longer has is retired.
 *
 * The add-only pass read the older text, so it is owed for this one.
 */
export function rereadLedger(
  previous: RequirementLedger,
  gddText: string,
  gdd: GddRef,
  milestones: readonly OwnerCandidate[],
  options: LedgerReadOptions,
): LedgerAmendment {
  const extracted = extractRequirementRows(gddText, {
    gddSha256: gdd.gddSha256,
    gddRevision: gdd.gddRevision,
    previous: previous.rows,
    proven: new Set(previous.rows.filter((r) => r.status === "passing").map((r) => r.rid)),
    ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
  });
  const before = new Map(previous.rows.map((r) => [r.rid, r]));
  const claimed = new Set<string>();
  const reopened: RequirementRow[] = [];
  // The reopened row's id → the waived row it replaces.
  const waiverLost = new Map<string, RequirementRow>();
  const renamed = new Map<string, string>();
  let unchanged = 0;
  let cosmetic = 0;
  let added = 0;
  const rows = extracted.rows.map((row) => {
    const same = before.get(row.rid);
    if (same !== undefined) {
      claimed.add(same.rid);
      unchanged += 1;
      return carried(row, same);
    }
    const predecessor = (decodeRequirement(row.encoded).identity?.supersedes ?? [])
      .map((id) => before.get(id))
      .find((p): p is RequirementRow => p !== undefined);
    if (predecessor === undefined) {
      added += 1;
      return row;
    }
    claimed.add(predecessor.rid);
    if (contentFingerprint(predecessor.text) === contentFingerprint(row.text)) {
      cosmetic += 1;
      renamed.set(predecessor.rid, row.rid);
      return carried(row, predecessor);
    }
    const open = reopenedFrom(row, predecessor, options.atMs);
    reopened.push(open);
    if (predecessor.status === "waived") waiverLost.set(open.rid, predecessor);
    return open;
  });

  const rids = new Set(rows.map((r) => r.rid));
  const kept: RequirementRow[] = [];
  const retired: RequirementRow[] = [];
  for (const old of previous.rows) {
    if (claimed.has(old.rid)) continue;
    const at = old.source === "extracted" || rids.has(old.rid) ? -1 : gddText.indexOf(old.text);
    if (at < 0) retired.push(old);
    else kept.push(rebound(old, gddText, at, gdd));
  }

  const owned = ownRows([...rows, ...kept], milestones, options);
  // Reopened as the ownership pass left them: a changed row the plan still excludes stays out of judgement, not open again.
  const changedAsk = new Set(reopened.map((r) => r.rid));
  const stillExcluded = new Set(owned.filter((r) => changedAsk.has(r.rid) && r.status === "excluded").map((r) => r.rid));
  return {
    ledger: {
      version: 1,
      gddSha256: gdd.gddSha256,
      gddRevision: gdd.gddRevision,
      extractedAtMs: options.atMs,
      rows: owned,
      overflow: extracted.overflow,
      numberingGaps: extracted.numberingGaps,
      llmAdded: kept.filter((r) => r.source === "llm-added").length,
      ...(previous.modelPassRevision === undefined ? {} : { modelPassRevision: previous.modelPassRevision }),
    },
    unchanged,
    cosmetic,
    renamed,
    reopened: owned.filter((r) => changedAsk.has(r.rid) && !stillExcluded.has(r.rid)),
    changedExcluded: stillExcluded.size,
    // A person decides again only where the new ask is judged.
    waiversDropped: [...waiverLost].filter(([rid]) => !stillExcluded.has(rid)).map(([, waived]) => waived),
    added,
    kept: kept.length,
    retired,
  };
}

/** Whether the add-only pass is still owed for the revision this ledger was read from. */
export function modelPassOwed(ledger: RequirementLedger): boolean {
  return (ledger.modelPassRevision ?? 0) < ledger.gddRevision;
}

export interface ModelPass {
  readonly ledger: RequirementLedger;
  readonly added: number;
  readonly rejected: number;
  readonly calls: number;
  readonly failedCalls: number;
  /** False when every call failed: nothing was read, and the pass stays owed. */
  readonly ran: boolean;
}

/**
 * The add-only pass over the approved text: rows it adds quote the document
 * verbatim and are given owners like any other; no row is removed or
 * reclassified. A pass whose every call failed read nothing and stays owed.
 */
export async function completeLedgerByModel(
  ledger: RequirementLedger,
  gddText: string,
  ask: CompleteText,
  milestones: readonly OwnerCandidate[],
  options: LedgerReadOptions,
): Promise<ModelPass> {
  const pass = await proposeRowsAddOnly(gddText, ask, ledger.rows, { gddSha256: ledger.gddSha256, gddRevision: ledger.gddRevision });
  const ran = pass.calls === 0 || pass.failedCalls < pass.calls;
  const counts = { rejected: pass.rejected.length, calls: pass.calls, failedCalls: pass.failedCalls, ran };
  if (!ran) return { ledger, added: 0, ...counts };
  return {
    ledger: {
      ...ledger,
      rows: ownRows([...ledger.rows, ...pass.added], milestones, options),
      llmAdded: ledger.llmAdded + pass.added.length,
      modelPassRevision: ledger.gddRevision,
    },
    added: pass.added.length,
    ...counts,
  };
}

/** What a person is told when the ledger is first read: the report's own lines, plus the kinds and the owners. */
export function describeLedgerRead(ledger: RequirementLedger, milestones: readonly Pick<CampaignMilestone, "id">[]): string {
  const kinds = new Map<RequirementKind, number>();
  for (const row of ledger.rows) kinds.set(row.kind, (kinds.get(row.kind) ?? 0) + 1);
  const owners = milestones
    .filter((m) => isPlannedMilestone(m.id))
    .map((m) => `${m.id} ${ledger.rows.filter((r) => r.owner === m.id).length}`);
  const [head, ...rest] = ledgerLines(ledger);
  return [
    `📋 GDD rows: ${head}.`,
    `By kind: ${[...kinds].map(([kind, n]) => `${n} ${kind}`).join(", ") || "none"}. Owned: ${owners.join(", ") || "none"}.`,
    ...rest,
  ].join("\n");
}

/** What a person is told when an amendment re-read the ledger. */
export function describeAmendment(amendment: LedgerAmendment): string {
  const { ledger, reopened, retired, waiversDropped } = amendment;
  const named = (rows: readonly RequirementRow[]): string =>
    rows.slice(0, 6).map(rowRef).join(", ") + (rows.length > 6 ? `, …and ${rows.length - 6} more` : "");
  // Every row the ledger now holds is in one of these counts, so they add up to what was read.
  const lines = [
    `📋 GDD rows re-read from the amended document (${ledger.gddSha256.slice(0, 8)}, revision ${ledger.gddRevision}): ` +
      `${amendment.unchanged} unchanged, ${amendment.cosmetic} reworded cosmetically (result and test kept), ` +
      `${reopened.length} reopened because what they ask changed, ` +
      (amendment.changedExcluded > 0 ? `${amendment.changedExcluded} changed but still excluded by the plan, ` : "") +
      `${amendment.added} new, ` +
      (amendment.kept > 0 ? `${amendment.kept} added earlier by the model or a review, still quoted, ` : "") +
      `${retired.length} retired.`,
  ];
  if (reopened.length > 0) lines.push(`Reopened, their checks superseded: ${named(reopened)}.`);
  if (waiversDropped.length > 0) {
    lines.push(`A waiver no longer applies — the GDD changed what these ask, so a person decides again: ${named(waiversDropped)}.`);
  }
  if (retired.length > 0) lines.push(`No longer in the GDD: ${named(retired)}.`);
  if (modelPassOwed(ledger)) lines.push("The add-only pass reads the amended document at the next settle or revive.");
  return lines.join("\n");
}
