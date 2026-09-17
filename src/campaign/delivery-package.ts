/**
 * THE PERSISTENT DELIVERY PACKAGE (plan 6.1).
 *
 * Everything a finished piece of work is reviewed from — the change, the
 * artifact, the command that runs it, the play-through, the checklist of the
 * behaviour that was asked for, the gaps still open, the cost and the duration
 * — lived in ONE chat message. `buildDeliveryReport` composes it, the messenger
 * sends it, and it scrolls away: a reviewer who opens the portal in another
 * browser, or after a daemon restart, has nothing but a campaign card with
 * milestone titles. Every proof the delivery gate measured (compile, suite,
 * player build, play-through, receipts) was already durable; what was missing
 * was one addressable place that says, for a campaign, what the work IS.
 *
 * This module is that place, and it MEASURES NOTHING OF ITS OWN. Every field
 * is copied from a store that already owns it — the campaign record, the
 * evidence ledger, the build verdict, HOW_TO_RUN.md, the budget ledger — and
 * every field that nobody measured is a row that says so. The four states are
 * kept apart on purpose:
 *
 *   present      — it is here, and the row says where it is
 *   failed       — it was measured and the measurement says no
 *   missing      — something looked for it and it is not there
 *   not-measured — nothing looked; the package claims nothing either way
 *
 * A piece is NEVER omitted. The failure this exists to prevent is a page that
 * renders six sections and reads complete, because the seventh had no data: an
 * absent play-through must read as an absent play-through.
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { configureSqlitePragmas } from "../memory/unified/sqlite-pragmas.js";
import type { LedgerRow } from "./evidence-ledger.js";
import { describeLedgerRow } from "./evidence-ledger.js";
import { suiteCommand, testPlatformFromVerdict } from "./how-to-run.js";
import type { Campaign, CampaignMilestone } from "./types.js";

// ---------------------------------------------------------------------------
// SHAPE
// ---------------------------------------------------------------------------

/** The seven things a reviewer needs, in the order they are read. */
export const DELIVERY_PIECE_ORDER = [
  "diff",
  "artifact",
  "run-command",
  "playthrough",
  "checklist",
  "gaps",
  "cost",
] as const;

export type DeliveryPieceId = (typeof DELIVERY_PIECE_ORDER)[number];

/**
 * What is known about one piece.
 *
 * `missing` and `not-measured` are different answers and must never collapse:
 * "the build ran and produced no artifact" is a defect, "no build was ever
 * run" is an absent measurement, and a page that renders both as a blank
 * section tells the reviewer the same lie twice.
 */
export type DeliveryPieceState = "present" | "failed" | "missing" | "not-measured";

/** Something the reviewer can act on: a path, a command, a digest, a link. */
export interface DeliveryLocator {
  readonly kind: "path" | "command" | "sha256" | "revision" | "url";
  readonly label: string;
  readonly value: string;
}

/** One line of the behaviour checklist, or one open gap. */
export interface DeliveryItem {
  readonly text: string;
  readonly state: "met" | "not-met" | "open" | "not-measured";
  /** WHAT said so — the sprint, the claim check, the audit. Never a guess. */
  readonly source: string;
  /** Why it is open, or what about a met item is still unproven. */
  readonly cause?: string;
}

export interface DeliveryPiece {
  readonly id: DeliveryPieceId;
  readonly title: string;
  readonly state: DeliveryPieceState;
  /** One sentence, stating only what is actually known. */
  readonly summary: string;
  /** WHERE the sentence comes from: the record, file or tool that produced it. */
  readonly source: string;
  readonly locators?: readonly DeliveryLocator[];
  /**
   * Plain lines this piece carries — the commits of a change, say. NOT items:
   * an item has a met/open state and a commit has none, and rendering a commit
   * under a state label would state a verdict nobody reached.
   */
  readonly lines?: readonly string[];
  readonly items?: readonly DeliveryItem[];
  /** Items beyond the cap, so a truncated list never reads as the whole one. */
  readonly itemsOmitted?: number;
  /** Named parts of THIS piece that nothing measured. Rendered, not hidden. */
  readonly missing?: readonly string[];
}

/**
 * A green whose proof is absent or refused, with the record that exposed it.
 *
 * The plan's measure is "every false green has a root cause recorded". A
 * caveat sentence in a chat message is not a record: this list is, and it is
 * keyed to the claim it contradicts.
 */
export interface DeliveryFalseGreen {
  /** The claim as the system made it ("Sprint C landed green"). */
  readonly claim: string;
  /** Why that claim is not the measurement it looks like. */
  readonly rootCause: string;
  /** The record this was read from — a verdict field, a ledger refusal. */
  readonly source: string;
}

export interface DeliveryPackage {
  readonly schemaVersion: 1;
  readonly campaignId: string;
  /** The task the delivered work ran as, when the campaign recorded one. */
  readonly taskId?: string;
  readonly milestoneId?: string;
  /** What the work was, as the ladder named it. */
  readonly title: string;
  readonly projectRoot: string;
  readonly campaignState: string;
  readonly assembledAt: number;
  /** Always DELIVERY_PIECE_ORDER.length entries, in that order. */
  readonly pieces: readonly DeliveryPiece[];
  readonly falseGreens: readonly DeliveryFalseGreen[];
  readonly falseGreensOmitted?: number;
  /** The dispatch ledger, one line each (see describeLedgerRow). */
  readonly receipts: readonly string[];
  /** Why there are no receipt lines, when there are none. */
  readonly receiptsNote?: string;
  readonly completeness: {
    readonly of: number;
    readonly present: number;
    readonly failed: number;
    readonly missing: number;
    readonly notMeasured: number;
  };
}

/** At most this many checklist/gap items per piece; the rest are counted. */
export const MAX_DELIVERY_ITEMS = 40;
/** At most this many receipt lines; the rest are counted in a trailing line. */
export const MAX_DELIVERY_RECEIPTS = 12;
/** At most this many false greens; the rest are counted. */
export const MAX_FALSE_GREENS = 30;

// ---------------------------------------------------------------------------
// FACTS IN
// ---------------------------------------------------------------------------

/**
 * The campaign fields the package is assembled from. A Pick, so a field that
 * changes shape in types.ts breaks here instead of drifting.
 */
export type DeliveryCampaignFacts = Pick<
  Campaign,
  | "id"
  | "projectRoot"
  | "state"
  | "milestones"
  | "createdAt"
  | "updatedAt"
  | "gddPath"
  | "pendingCoverageGaps"
  | "coverageAuditNote"
  | "lastError"
  | "planCoverage"
  | "deliveryRoundsTotal"
>;

/** The change the delivery is: commits and the command that shows them. */
export interface DeliveryDiffFacts {
  /**
   * True when the commit history could not be read at all. An unreadable
   * history is NOT an empty one: "the work left no commit" is a defect and
   * "git could not answer" is an absent measurement (see [[verdicts-must-name-
   * what-they-measured]]).
   */
  readonly unreadable?: boolean;
  /** The commit range, as `git diff` would take it. */
  readonly range?: string;
  readonly commits: readonly { readonly sha: string; readonly subject: string }[];
  readonly filesChanged?: number;
  readonly insertions?: number;
  readonly deletions?: number;
  /** The command that prints the diff. Named, never run by the reader's guess. */
  readonly command?: string;
  /** Why a field above is absent, when one is. */
  readonly note?: string;
}

/** The artifact, as the build verdict recorded it and as disk answers now. */
export interface DeliveryArtifactFacts {
  readonly verdict?: CampaignMilestone["buildVerdict"];
  /** Whether the recorded path is still on disk, when anything looked. */
  readonly onDisk?: boolean;
  /** The digest of those bytes, when it was taken (see artifactDigest). */
  readonly sha256?: string;
  /** The command that runs the artifact, when one can be named. */
  readonly runCommand?: string;
  readonly note?: string;
}

/** HOW_TO_RUN.md — the file the reviewer opens first. */
export interface DeliveryHowToRunFacts {
  /** Project-relative path, when it was written. */
  readonly path?: string;
  readonly writtenAt?: number;
  /** The suite command the file names, when the file names one. */
  readonly suiteCommand?: string;
  readonly note?: string;
}

/** The play-through recording: the file, not the verdict about it. */
export interface DeliveryRecordingFacts {
  readonly path?: string;
  readonly sizeBytes?: number;
  readonly kind?: string;
  /** A portal link, when the file was registered as an attachment. */
  readonly href?: string;
  readonly note?: string;
}

/** What the work cost and how long it took. */
export interface DeliverySpendFacts {
  readonly usd?: number;
  readonly usdNote?: string;
  readonly durationMs?: number;
  readonly durationNote?: string;
  /** WHERE the numbers come from (the budget ledger, the milestone clock). */
  readonly source?: string;
}

export interface DeliveryPackageFacts {
  readonly campaign: DeliveryCampaignFacts;
  readonly now?: number;
  readonly diff?: DeliveryDiffFacts;
  readonly artifact?: DeliveryArtifactFacts;
  readonly howToRun?: DeliveryHowToRunFacts;
  readonly recording?: DeliveryRecordingFacts;
  readonly spend?: DeliverySpendFacts;
  /** The dispatch ledger for the delivering sprint, already read. */
  readonly receipts?: readonly LedgerRow[];
  /** Why the ledger could not be read, when it could not. */
  readonly receiptsNote?: string;
}

// ---------------------------------------------------------------------------
// ASSEMBLY
// ---------------------------------------------------------------------------

function cap<T>(items: readonly T[], max: number): { kept: readonly T[]; omitted: number } {
  return items.length <= max
    ? { kept: items, omitted: 0 }
    : { kept: items.slice(0, max), omitted: items.length - max };
}

function piece(
  id: DeliveryPieceId,
  title: string,
  state: DeliveryPieceState,
  summary: string,
  source: string,
  extra: {
    locators?: readonly DeliveryLocator[];
    lines?: readonly string[];
    items?: readonly DeliveryItem[];
    missing?: readonly string[];
  } = {},
): DeliveryPiece {
  const { kept, omitted } = cap(extra.items ?? [], MAX_DELIVERY_ITEMS);
  return {
    id,
    title,
    state,
    summary,
    source,
    ...(extra.locators && extra.locators.length > 0 ? { locators: extra.locators } : {}),
    ...(extra.lines && extra.lines.length > 0 ? { lines: extra.lines } : {}),
    ...(kept.length > 0 ? { items: kept } : {}),
    ...(omitted > 0 ? { itemsOmitted: omitted } : {}),
    ...(extra.missing && extra.missing.length > 0 ? { missing: extra.missing } : {}),
  };
}

/** The milestone the delivery rests on: the last one, which is the final sprint. */
function finalMilestone(campaign: DeliveryCampaignFacts): CampaignMilestone | undefined {
  return campaign.milestones[campaign.milestones.length - 1];
}

function diffPiece(facts: DeliveryPackageFacts): DeliveryPiece {
  const d = facts.diff;
  if (d === undefined) {
    return piece(
      "diff",
      "The change",
      "not-measured",
      "NOT MEASURED — nothing read this delivery's commits, so the package cannot say what changed.",
      "no diff facts were gathered for this package",
      { missing: ["commits", "files changed", "the command that shows the diff"] },
    );
  }
  if (d.unreadable === true) {
    return piece(
      "diff",
      "The change",
      "not-measured",
      `NOT MEASURED — the commit history could not be read: ${d.note ?? "no reason recorded"}.`,
      "git could not answer for this project",
      { missing: ["commits", "files changed", "the command that shows the diff"] },
    );
  }
  const locators: DeliveryLocator[] = [];
  if (d.range) locators.push({ kind: "revision", label: "commit range", value: d.range });
  if (d.command) locators.push({ kind: "command", label: "show the diff", value: d.command });
  const missing: string[] = [];
  if (d.filesChanged === undefined) missing.push("files changed");
  if (d.insertions === undefined || d.deletions === undefined) missing.push("lines added/removed");
  if (d.command === undefined) missing.push("the command that shows the diff");
  if (d.commits.length === 0) {
    return piece(
      "diff",
      "The change",
      "missing",
      `NO COMMIT — the work left no commit in the recorded range. ${d.note ?? "Nothing recorded why."}`,
      d.note ?? "the campaign's own commit record",
      { locators, missing },
    );
  }
  const shown = cap(d.commits, 10);
  const counts =
    d.filesChanged === undefined
      ? ""
      : `, ${d.filesChanged} file${d.filesChanged === 1 ? "" : "s"}` +
        (d.insertions !== undefined && d.deletions !== undefined ? ` (+${d.insertions}/-${d.deletions})` : "");
  return piece(
    "diff",
    "The change",
    "present",
    `${d.commits.length} commit${d.commits.length === 1 ? "" : "s"}${counts}.` +
      (d.note ? ` ${d.note}` : ""),
    "the delivering sprint's own commits",
    {
      locators,
      lines: shown.kept.map((c) => `${c.sha.slice(0, 12)} ${c.subject}`),
      ...(shown.omitted > 0 ? { missing: [...missing, `${shown.omitted} earlier commit(s) not listed here`] } : { missing }),
    },
  );
}

function artifactPiece(facts: DeliveryPackageFacts): DeliveryPiece {
  const a = facts.artifact;
  // The verdict the delivery gate recorded, wherever the caller passed it: the
  // gatherer copies it into the facts, and a caller that passes only the
  // campaign still gets the build its own record holds — never a "no build was
  // recorded" line about a build that is right there.
  const verdict = a?.verdict ?? finalMilestone(facts.campaign)?.buildVerdict;
  if (verdict === undefined) {
    return piece(
      "artifact",
      "The build artifact",
      "not-measured",
      "NOT MEASURED — no player build was recorded for this delivery, so there is no artifact to review.",
      a?.note ?? "the delivering sprint recorded no buildVerdict",
      { missing: ["artifact path", "size", "target", "digest"] },
    );
  }
  if (!verdict.ran) {
    return piece(
      "artifact",
      "The build artifact",
      "not-measured",
      `NOT MEASURED — the build never ran at the delivery gate: ${verdict.detail ?? "no builder"}.`,
      "buildVerdict.ran = false",
      { missing: ["artifact path", "size", "target", "digest"] },
    );
  }
  if (verdict.ok !== true) {
    return piece(
      "artifact",
      "The build artifact",
      "failed",
      `THE BUILD FAILED — ${(verdict.reasons ?? []).slice(0, 3).join("; ") || verdict.detail || "no reason recorded"}.`,
      "buildVerdict.ok = false",
      { missing: ["a runnable artifact"] },
    );
  }
  const locators: DeliveryLocator[] = [];
  if (verdict.artifactPath) locators.push({ kind: "path", label: "artifact", value: verdict.artifactPath });
  if (a?.sha256) locators.push({ kind: "sha256", label: "artifact digest", value: a.sha256 });
  const missing: string[] = [];
  if (a?.sha256 === undefined) missing.push("the artifact's digest");
  if (a?.onDisk === undefined) missing.push("whether the artifact is still on disk");
  const size = typeof verdict.sizeBytes === "number" ? `${(verdict.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : "size not recorded";
  if (a?.onDisk === false) {
    return piece(
      "artifact",
      "The build artifact",
      "missing",
      `GONE — the build reported \`${verdict.artifactPath ?? "?"}\` (${verdict.target ?? "target not recorded"}, ${size}) and that path is no longer on disk.`,
      "the recorded artifactPath was probed and is absent",
      { locators, missing },
    );
  }
  return piece(
    "artifact",
    "The build artifact",
    "present",
    `Built: \`${verdict.artifactPath ?? "?"}\` (${verdict.target ?? "target not recorded"}, ${size}` +
      (typeof verdict.durationMs === "number" ? `, built in ${Math.round(verdict.durationMs / 1000)} s` : "") +
      ")." +
      ((verdict.unbuiltTargets ?? []).length > 0
        ? ` The document also asks for ${(verdict.unbuiltTargets ?? []).join(", ")} — NOT built here.`
        : ""),
    "buildVerdict from the delivery gate",
    { locators, missing },
  );
}

function runCommandPiece(facts: DeliveryPackageFacts): DeliveryPiece {
  const h = facts.howToRun;
  const runCommand = facts.artifact?.runCommand;
  const locators: DeliveryLocator[] = [];
  if (h?.path) locators.push({ kind: "path", label: "HOW_TO_RUN.md", value: h.path });
  if (runCommand) locators.push({ kind: "command", label: "run the artifact", value: runCommand });
  if (h?.suiteCommand) locators.push({ kind: "command", label: "re-run the suite", value: h.suiteCommand });
  const missing: string[] = [];
  if (runCommand === undefined) missing.push("the command that runs the built artifact");
  if (h?.suiteCommand === undefined) missing.push("the command that re-runs the suite");
  if (h?.path === undefined) {
    return piece(
      "run-command",
      "How to run it",
      "missing",
      `NO HOW_TO_RUN.md — ${h?.note ?? "nothing wrote one for this delivery"}.` +
        (runCommand ? ` The artifact command is recorded here: \`${runCommand}\`.` : ""),
      h?.note ?? "no HOW_TO_RUN facts were gathered",
      { locators, missing },
    );
  }
  return piece(
    "run-command",
    "How to run it",
    "present",
    `\`${h.path}\` at the project root names the Unity version, the entry scene, how to play and the command that re-runs the suite.` +
      (h.note ? ` ${h.note}` : ""),
    "HOW_TO_RUN.md, written at the delivery gate",
    { locators, missing },
  );
}

/** One sentence about a play-through evidence record, without judging it again. */
function describePlaythroughForPackage(e: CampaignMilestone["playthroughVerdict"]): string {
  if (e === undefined) return "no play-through record";
  if (e.unreadable === true) return "the play-through record could not be read";
  if (e.stale === true) return "the play-through record predates the sprint — it describes an older game";
  if (!e.found) return `no play-through record for this sprint${e.missing ? ` — ${e.missing}` : ""}`;
  const sessions = e.sessions?.length ?? 0;
  const outcome = e.outcome ? `, outcome ${e.outcome}` : "";
  const actions = typeof e.actions === "number" ? `, ${e.actions} actions` : "";
  // The frame count is the recording's own size, and "how many were flat" is
  // the difference between a recording of a game and a recording of a colour.
  const frames = e.frames
    ? `, ${e.frames.count} frames recorded (${e.frames.flat} flat)`
    : ", frame count NOT recorded";
  return `${e.ok === true ? "played" : "PLAY FAILED"}: ${sessions} session${sessions === 1 ? "" : "s"}${actions}${outcome}${frames}` +
    (e.ok === true ? "" : ` — ${(e.reasons ?? []).slice(0, 2).join("; ") || "no reason recorded"}`);
}

function playthroughPiece(facts: DeliveryPackageFacts): DeliveryPiece {
  const m = finalMilestone(facts.campaign);
  // The player run is the one that speaks for what a person sees; the editor
  // play-through is the fallback, and which one this is must be said.
  const inPlayer = m?.playerPlaythrough;
  const inEditor = m?.playthroughVerdict;
  const rec = facts.recording;
  const locators: DeliveryLocator[] = [];
  if (rec?.path) locators.push({ kind: "path", label: "recording", value: rec.path });
  if (rec?.href) locators.push({ kind: "url", label: "recording (portal)", value: rec.href });
  const missing: string[] = [];
  if (rec?.path === undefined) missing.push(`the recording file${rec?.note ? ` (${rec.note})` : ""}`);
  // Only the run INSIDE THE BUILT PLAYER speaks for what a person sees, so its
  // absence is a named gap even when the editor played the game. The reverse is
  // not a gap: an editor run adds nothing to a player run that happened.
  if (inPlayer === undefined) missing.push("a play-through inside the built player");
  const evidence = inPlayer ?? inEditor;
  if (evidence === undefined) {
    return piece(
      "playthrough",
      "The play-through",
      "not-measured",
      "NOT MEASURED — nobody played the game at the delivery gate, in the player or in the editor.",
      "the delivering sprint recorded neither playerPlaythrough nor playthroughVerdict",
      { locators, missing },
    );
  }
  const where = inPlayer !== undefined ? "inside the built player" : "in the editor (NOT the shipped player)";
  const sentence = `${where}: ${describePlaythroughForPackage(evidence)}`;
  const state: DeliveryPieceState =
    evidence.found !== true || evidence.stale === true || evidence.unreadable === true
      ? "missing"
      : evidence.ok === true
        ? "present"
        : "failed";
  return piece("playthrough", "The play-through", state, sentence, `playthrough evidence recorded ${where}`, {
    locators,
    missing,
  });
}

/** MET / NOT MET / NOT MEASURED, as gdd-claims.ts writes the line. */
function claimState(line: string): DeliveryItem["state"] {
  if (/: MET — /.test(line)) return "met";
  if (/: NOT MET — /.test(line)) return "not-met";
  return "not-measured";
}

function checklistItems(campaign: DeliveryCampaignFacts): DeliveryItem[] {
  const items: DeliveryItem[] = [];
  for (const m of campaign.milestones) {
    // A repair sprint exists to close ONE requirement; its own status is not
    // that requirement's verdict (Codex 2026-09-12 V#7), so the closure is
    // stated as what it is.
    const text = m.coverageGap ?? m.title;
    const source = `sprint ${m.id}`;
    if (m.coverageGap !== undefined && m.coverageClosed === true) {
      items.push({
        text,
        state: "met",
        source: "the evidence audit",
        cause: `the sprint ended ${m.status}; the audit then found the requirement delivered${
          m.coverageClosedRevision ? ` at ${m.coverageClosedRevision.slice(0, 8)}` : ""
        }`,
      });
      continue;
    }
    if (m.status === "green") {
      // A green that nothing proved is still not a met requirement; the reason
      // rides with the item so the checklist never reads better than the
      // evidence under it.
      const unproven: string[] = [];
      if (m.compileVerdict === undefined) unproven.push("the tree was never compiled for this sprint");
      else if (!m.compileVerdict.ran) unproven.push("compile NOT measured");
      else if (m.compileVerdict.refused !== undefined) unproven.push(`the compile proof was refused (${m.compileVerdict.refused})`);
      if (m.testVerdict === undefined) unproven.push("no observed test run");
      else if (m.testVerdictUnfiltered !== true) unproven.push("its green test run was FILTERED, not the whole suite");
      items.push({
        text,
        state: "met",
        source,
        ...(unproven.length > 0 ? { cause: `green, but ${unproven.join("; ")}` } : {}),
      });
      continue;
    }
    items.push({
      text,
      state: "open",
      source,
      cause: `the sprint ended ${m.status}${campaign.lastError ? ` — ${campaign.lastError}` : ""}`,
    });
  }
  // The GDD's own numbers, held against what was measured. The last sprint
  // that has them is the delivery's reading.
  const claims = [...campaign.milestones].reverse().find((m) => (m.gddClaims ?? []).length > 0)?.gddClaims ?? [];
  for (const line of claims) {
    items.push({ text: line, state: claimState(line), source: "the GDD's own numbers, checked at delivery" });
  }
  // Sections of the document no sprint was given. Not a failure of the work —
  // an absence of coverage, and it must not read as delivered behaviour.
  for (const section of campaign.planCoverage?.uncovered ?? []) {
    items.push({
      text: `GDD section "${section}"`,
      state: "not-measured",
      source: "plan coverage",
      cause: "no sprint in the ladder was given this section",
    });
  }
  return items;
}

function checklistPiece(facts: DeliveryPackageFacts): DeliveryPiece {
  const items = checklistItems(facts.campaign);
  if (items.length === 0) {
    return piece(
      "checklist",
      "What was asked for",
      "not-measured",
      "NOT MEASURED — this campaign has no ladder, no claim check and no plan coverage, so nothing states what was asked for.",
      "the campaign record carries no milestones",
      { missing: ["the requirement list"] },
    );
  }
  const met = items.filter((i) => i.state === "met").length;
  const notMet = items.filter((i) => i.state === "not-met").length;
  const open = items.filter((i) => i.state === "open").length;
  const unmeasured = items.filter((i) => i.state === "not-measured").length;
  const caveated = items.filter((i) => i.state === "met" && i.cause !== undefined).length;
  // ONE list, built rather than spread twice: two `missing` spreads meant the
  // second silently replaced the first, so a delivery with neither a GDD nor a
  // coverage reading named only one of them.
  const missing: string[] = [];
  if (facts.campaign.gddPath === undefined) missing.push("the GDD this was judged against");
  if (facts.campaign.planCoverage === undefined) missing.push("how the ladder covered the document");
  return piece(
    "checklist",
    "What was asked for",
    "present",
    `${items.length} line${items.length === 1 ? "" : "s"}: ${met} met (${caveated} of them with an unproven part), ` +
      `${notMet} not met, ${open} open, ${unmeasured} never measured.` +
      (facts.campaign.gddPath ? ` The document itself is \`${facts.campaign.gddPath}\`.` : " No GDD path was recorded."),
    "the milestone ladder, the GDD claim check and plan coverage",
    { items, missing },
  );
}

function gapItems(facts: DeliveryPackageFacts): DeliveryItem[] {
  const campaign = facts.campaign;
  const gaps: DeliveryItem[] = checklistItems(campaign).filter((i) => i.state !== "met");
  for (const gap of campaign.pendingCoverageGaps ?? []) {
    gaps.push({
      text: gap,
      state: "open",
      source: "the evidence audit",
      cause: "named as a gap and no sprint has been scheduled for it yet",
    });
  }
  const m = finalMilestone(campaign);
  for (const proof of m?.deliveryProofsMissing ?? []) {
    gaps.push({
      text: proof,
      state: "not-measured",
      source: `sprint ${m?.id ?? "?"}`,
      cause: "the final sprint's bounce budget ran out with this proof still missing",
    });
  }
  if (campaign.coverageAuditNote !== undefined) {
    gaps.push({
      text: "the GDD-coverage audit did not run clean",
      state: "not-measured",
      source: "the coverage audit",
      cause: campaign.coverageAuditNote,
    });
  }
  const structural = [...campaign.milestones].reverse().find((x) => x.structureRefused === true);
  if (structural !== undefined) {
    gaps.push({
      text: "the shipped scenes are not built the way the GDD specifies",
      state: "not-met",
      source: `the structural check on sprint ${structural.id}`,
      cause: structural.structureFindings?.[0] ?? "the check refused the delivery and recorded no finding",
    });
  }
  const hygiene = [...campaign.milestones].reverse().find((x) => x.sceneHygieneUnresolved !== undefined);
  if (hygiene?.sceneHygieneUnresolved !== undefined) {
    gaps.push({
      text: "no scene a person can open",
      state: "not-met",
      source: `scene hygiene on sprint ${hygiene.id}`,
      cause: hygiene.sceneHygieneUnresolved,
    });
  }
  return gaps;
}

function gapsPiece(facts: DeliveryPackageFacts): DeliveryPiece {
  const items = gapItems(facts);
  if (facts.campaign.milestones.length === 0) {
    return piece(
      "gaps",
      "What is still open",
      "not-measured",
      "NOT MEASURED — with no ladder and no audit record, nothing has looked for a gap.",
      "the campaign record carries no milestones",
      { missing: ["the open-gap list"] },
    );
  }
  if (items.length === 0) {
    return piece(
      "gaps",
      "What is still open",
      "present",
      "No open gap is recorded. That is the absence of a record, not a proof that none exist — " +
        "what was never measured is listed under the pieces above.",
      "the ladder, the coverage audit, the structural and hygiene checks",
    );
  }
  const open = items.filter((i) => i.state === "open" || i.state === "not-met").length;
  const unmeasured = items.length - open;
  return piece(
    "gaps",
    "What is still open",
    "present",
    `${items.length} open item${items.length === 1 ? "" : "s"}: ${open} measured as not delivered, ${unmeasured} never measured.` +
      (facts.campaign.deliveryRoundsTotal
        ? ` The delivery gate has run ${facts.campaign.deliveryRoundsTotal} round${facts.campaign.deliveryRoundsTotal === 1 ? "" : "s"}.`
        : ""),
    "the ladder, the coverage audit, the structural and hygiene checks",
    { items },
  );
}

function costPiece(facts: DeliveryPackageFacts): DeliveryPiece {
  const s = facts.spend;
  const missing: string[] = [];
  if (s?.usd === undefined) missing.push(`what it cost${s?.usdNote ? ` (${s.usdNote})` : ""}`);
  if (s?.durationMs === undefined) missing.push(`how long it took${s?.durationNote ? ` (${s.durationNote})` : ""}`);
  if (s?.usd === undefined && s?.durationMs === undefined) {
    return piece(
      "cost",
      "Cost and duration",
      "not-measured",
      "NOT MEASURED — neither the spend nor the elapsed time of this work was recorded against it.",
      s?.source ?? "no spend facts were gathered for this package",
      { missing },
    );
  }
  const parts: string[] = [];
  if (s?.usd !== undefined) parts.push(`$${s.usd.toFixed(2)}`);
  else parts.push(`cost NOT MEASURED${s?.usdNote ? ` (${s.usdNote})` : ""}`);
  if (s?.durationMs !== undefined) parts.push(`${(s.durationMs / 3_600_000).toFixed(1)} h wall clock`);
  else parts.push(`duration NOT MEASURED${s?.durationNote ? ` (${s.durationNote})` : ""}`);
  return piece("cost", "Cost and duration", "present", `${parts.join(", ")}.`, s?.source ?? "the daemon's budget ledger", {
    missing,
  });
}

/**
 * Greens whose proof is absent or refused.
 *
 * Read from records only: a verdict field that says "not measured", a ledger
 * refusal code, a dispatch nobody settled. Nothing here is inferred from
 * prose, because prose is where a measurement goes to hide.
 */
export function collectFalseGreens(facts: DeliveryPackageFacts): DeliveryFalseGreen[] {
  const out: DeliveryFalseGreen[] = [];
  for (const m of facts.campaign.milestones) {
    if (m.status !== "green") continue;
    const claim = `${m.title} landed green`;
    if (m.compileVerdict === undefined) {
      out.push({ claim, rootCause: "the tree was never compiled for this sprint", source: `sprint ${m.id}: no compileVerdict` });
    } else if (!m.compileVerdict.ran) {
      out.push({
        claim,
        rootCause: `compile NOT measured — ${m.compileVerdict.detail ?? "no verifier"}`,
        source: `sprint ${m.id}: compileVerdict.ran = false`,
      });
    } else if (m.compileVerdict.refused !== undefined) {
      out.push({
        claim,
        rootCause: `the compile proof was REFUSED — ${m.compileVerdict.refused}`,
        source: `sprint ${m.id}: compileVerdict.refused`,
      });
    }
    if (m.testVerdict === undefined) {
      out.push({ claim, rootCause: "no test run was ever observed for this sprint", source: `sprint ${m.id}: no testVerdict` });
    } else if (m.testVerdictUnfiltered !== true) {
      out.push({
        claim,
        rootCause: "its green test run was FILTERED — what the rest of the suite does was never observed",
        source: `sprint ${m.id}: testVerdictUnfiltered is not true`,
      });
    }
    if ((m.testFailures ?? []).length > 0) {
      out.push({
        claim,
        rootCause: `the suite reported these tests FAILING — ${(m.testFailures ?? []).slice(0, 5).join(", ")}`,
        source: `sprint ${m.id}: testFailures`,
      });
    }
    if (m.visualEvidence === "none-gate-not-demanded" || m.visualEvidence === "none-gate-spent") {
      out.push({
        claim,
        rootCause:
          m.visualEvidence === "none-gate-spent"
            ? "no fresh captured frame even after the visual bounce"
            : "no fresh captured frame, and the visual gate never ran — the sprint prompt never demanded a capture",
        source: `sprint ${m.id}: visualEvidence = ${m.visualEvidence}`,
      });
    }
  }
  // A dispatch that came back refused, or never came back at all. These are
  // the receipts the delivery rests on; a refusal is a recorded root cause.
  for (const row of facts.receipts ?? []) {
    if (row.state === "refused") {
      out.push({
        claim: `${row.kind} receipt for run ${row.runId.slice(0, 8)}`,
        rootCause: `REFUSED (${row.refusal ?? "unknown"}): ${row.detail ?? "no detail recorded"}`,
        source: "the evidence ledger",
      });
    } else if (row.state === "pending") {
      out.push({
        claim: `${row.kind} receipt for run ${row.runId.slice(0, 8)}`,
        rootCause: "the run was dispatched and no receipt came back — its provenance is unverified",
        source: "the evidence ledger",
      });
    }
  }
  if (facts.campaign.state === "done" && facts.campaign.milestones.some((m) => m.status !== "green")) {
    out.push({
      claim: "the campaign is done",
      rootCause: `${facts.campaign.milestones.filter((m) => m.status !== "green").length} sprint(s) never landed green`,
      source: "the campaign record",
    });
  }
  return out;
}

/**
 * Assemble the package from facts somebody else measured.
 *
 * PURE: no filesystem, no git, no clock beyond `now`. Everything it could not
 * be told is a row that says nothing measured it, which is exactly what the
 * caller must not be able to hide by passing less.
 */
export function assembleDeliveryPackage(facts: DeliveryPackageFacts): DeliveryPackage {
  const now = facts.now ?? Date.now();
  const pieces: DeliveryPiece[] = [
    diffPiece(facts),
    artifactPiece(facts),
    runCommandPiece(facts),
    playthroughPiece(facts),
    checklistPiece(facts),
    gapsPiece(facts),
    costPiece(facts),
  ];
  const falseGreens = cap(collectFalseGreens(facts), MAX_FALSE_GREENS);
  const receiptRows = facts.receipts ?? [];
  const receipts = cap(receiptRows.map((r) => describeLedgerRow(r)), MAX_DELIVERY_RECEIPTS);
  const receiptLines =
    receipts.omitted > 0
      ? [...receipts.kept, `+${receipts.omitted} earlier dispatch(es) in this sprint`]
      : [...receipts.kept];
  const m = finalMilestone(facts.campaign);
  const count = (state: DeliveryPieceState): number => pieces.filter((p) => p.state === state).length;
  return {
    schemaVersion: 1,
    campaignId: facts.campaign.id,
    ...(m?.taskId ? { taskId: m.taskId } : {}),
    ...(m?.id ? { milestoneId: m.id } : {}),
    title: m?.title ?? `Campaign ${facts.campaign.id}`,
    projectRoot: facts.campaign.projectRoot,
    campaignState: facts.campaign.state,
    assembledAt: now,
    pieces,
    falseGreens: falseGreens.kept,
    ...(falseGreens.omitted > 0 ? { falseGreensOmitted: falseGreens.omitted } : {}),
    receipts: receiptLines,
    ...(receiptLines.length === 0
      ? {
          receiptsNote:
            facts.receiptsNote ??
            "No producer dispatch was recorded for this sprint — nothing binds these proofs to the invocations that made them.",
        }
      : {}),
    completeness: {
      of: pieces.length,
      present: count("present"),
      failed: count("failed"),
      missing: count("missing"),
      notMeasured: count("not-measured"),
    },
  };
}

// ---------------------------------------------------------------------------
// FACTS: WHERE EACH ONE IS READ FROM
// ---------------------------------------------------------------------------

/**
 * The probes the gatherer is allowed to make, every one of them a seam.
 *
 * Injected rather than imported so the assembly can be tested without a git
 * repository, a Unity project or a player build on disk — and so a probe this
 * machine cannot make becomes a named "not measured" instead of an exception
 * that loses the whole package.
 */
export interface DeliveryFactSources {
  readonly projectRoot: string;
  /** Run git in the project root and return stdout; throw when it cannot. */
  readonly git?: (args: readonly string[]) => string;
  /** Size of a file, or undefined when it is not there. */
  readonly statSize?: (path: string) => number | undefined;
  /** The newest captured frame of the running game since `sinceMs`. */
  readonly selectFrame?: (projectRoot: string, sinceMs: number) => { path?: string; capturedAtMs?: number; reason?: string };
  /**
   * The artifact's content digest. DEFAULT OFF on purpose: the digest hashes
   * the whole player layout (see artifactDigest), which is gigabytes for a
   * real build, and the package is re-assembled on every delivery report. When
   * the caller already holds one it passes it; otherwise the package says the
   * digest was not recorded rather than paying for it here.
   */
  readonly artifactSha256?: string;
  /** Project-relative path of the HOW_TO_RUN the delivery report wrote. */
  readonly howToRunPath?: string;
  /** Why no HOW_TO_RUN path is known, when none is. */
  readonly howToRunNote?: string;
  /** The dispatch ledger for the delivering sprint, already read. */
  readonly ledgerRows?: readonly LedgerRow[];
  readonly ledgerNote?: string;
  /**
   * What this campaign's work cost, read from the budget ledger's own
   * per-campaign total (plan 6.1). `entries` is part of the answer: zero
   * entries means nothing was attributed to this work, which is not the same
   * as costing nothing, and the package says which.
   */
  readonly spend?: { readonly totalUsd: number; readonly entries: number };
  readonly now?: number;
}

/** When the delivered work began, by the clock the sprint itself kept. */
function sprintStart(campaign: DeliveryCampaignFacts): number {
  const m = finalMilestone(campaign);
  return m?.attemptStartedAtMs ?? m?.startedAtMs ?? campaign.createdAt;
}

/**
 * The commits the delivered work is, read from the project's own history.
 *
 * The campaign persists `commitNote` — a hash and up to twelve paths — and
 * nothing else: there is no table of a task's commits (searched 2026-09-17).
 * So the history is re-read here, bounded by the sprint's own clock, and every
 * number it could not get is named rather than estimated.
 */
export function gatherDiffFacts(sources: DeliveryFactSources, sinceMs: number): DeliveryDiffFacts {
  const git = sources.git;
  if (git === undefined) {
    return { commits: [], unreadable: true, note: "no git probe was available to this process" };
  }
  const iso = new Date(sinceMs).toISOString();
  let raw: string;
  try {
    raw = git(["log", `--since=${iso}`, "--no-merges", "--pretty=format:%H%x09%s"]);
  } catch (err) {
    return { commits: [], unreadable: true, note: err instanceof Error ? err.message : String(err) };
  }
  const commits = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const tab = line.indexOf("\t");
      return tab < 0
        ? { sha: line, subject: "(no subject)" }
        : { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    })
    // Oldest first: a reviewer reads a change forwards.
    .reverse();
  if (commits.length === 0) {
    return { commits: [], note: `No commit since ${iso} — the sprint's own clock.` };
  }
  const oldest = commits[0]!.sha;
  const newest = commits[commits.length - 1]!.sha;
  let filesChanged: number | undefined;
  try {
    const names = git(["log", `--since=${iso}`, "--no-merges", "--name-only", "--pretty=format:"]);
    filesChanged = new Set(names.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)).size;
  } catch {
    filesChanged = undefined;
  }
  // The range only exists when the oldest commit HAS a parent: on a repository
  // whose first commit is in the range there is nothing to diff against, and a
  // command that fails is worse than one that is not offered.
  let range: string | undefined;
  try {
    git(["rev-parse", "--verify", `${oldest}~1`]);
    range = `${oldest}~1..${newest}`;
  } catch {
    range = undefined;
  }
  return {
    commits,
    ...(filesChanged === undefined ? {} : { filesChanged }),
    ...(range === undefined
      ? {
          note: `The oldest commit in this range has no parent, so there is no ${oldest.slice(0, 8)}~1 to diff against; read the commits themselves.`,
          command: `git -C ${sources.projectRoot} show ${oldest}`,
        }
      : { range, command: `git -C ${sources.projectRoot} diff --stat --patch ${range}` }),
  };
}

/**
 * The command that RUNS the built artifact, when the artifact is a thing a
 * command can run.
 *
 * Read from the path's own shape, never from the host platform: a macOS bundle
 * is opened, an executable is executed, and a WebGL build is NOT a command at
 * all — it has to be served over HTTP, and offering a shell line for it would
 * be a command that cannot work.
 */
export function artifactRunCommand(artifactPath: string | undefined): { command?: string; note?: string } {
  if (artifactPath === undefined || artifactPath === "") return { note: "the build recorded no artifact path" };
  const lower = artifactPath.toLowerCase();
  if (lower.endsWith(".app")) return { command: `open "${artifactPath}"` };
  if (lower.endsWith("index.html")) {
    return { note: "a WebGL build is not a command — it must be served over HTTP from its own folder" };
  }
  if (lower.endsWith(".apk")) return { command: `adb install "${artifactPath}"` };
  return { command: `"${artifactPath}"` };
}

/**
 * Read every fact the package is made of from the store that owns it.
 *
 * NOTHING IS MEASURED TWICE HERE: the build verdict, the play-through
 * evidence, the claim lines, the coverage queue and the receipts are copied
 * from the campaign record and the evidence ledger. The only probes are the
 * commit history, the artifact's presence on disk and the newest captured
 * frame — and each one that fails becomes a named absence.
 */
export function gatherDeliveryPackageFacts(
  campaign: DeliveryCampaignFacts,
  sources: DeliveryFactSources,
): DeliveryPackageFacts {
  const now = sources.now ?? Date.now();
  const since = sprintStart(campaign);
  const m = finalMilestone(campaign);
  const verdict = m?.buildVerdict;
  const artifactPath = verdict?.artifactPath;
  const onDisk = artifactPath === undefined || sources.statSize === undefined ? undefined : sources.statSize(artifactPath) !== undefined;
  const run = artifactRunCommand(artifactPath);
  const frame = sources.selectFrame?.(sources.projectRoot, since);
  const frameSize = frame?.path !== undefined ? sources.statSize?.(frame.path) : undefined;
  return {
    campaign,
    now,
    diff: gatherDiffFacts(sources, since),
    artifact: {
      ...(verdict === undefined ? {} : { verdict }),
      ...(onDisk === undefined ? {} : { onDisk }),
      ...(sources.artifactSha256 === undefined ? {} : { sha256: sources.artifactSha256 }),
      ...(run.command === undefined ? {} : { runCommand: run.command }),
      ...(run.note === undefined ? {} : { note: run.note }),
    },
    howToRun: {
      ...(sources.howToRunPath === undefined ? {} : { path: sources.howToRunPath }),
      ...(sources.howToRunNote === undefined ? {} : { note: sources.howToRunNote }),
      suiteCommand: suiteCommand(campaign.projectRoot, testPlatformFromVerdict(m?.testVerdict)),
    },
    recording: {
      ...(frame?.path === undefined ? {} : { path: frame.path, kind: "captured frame" }),
      ...(frameSize === undefined ? {} : { sizeBytes: frameSize }),
      ...(frame?.path === undefined
        ? { note: frame?.reason ?? "nothing looked for a captured frame" }
        : {}),
    },
    spend: {
      // The ledger keys spend by campaign now (plan 6.1): a total with no
      // entries behind it is reported as UNATTRIBUTED, never as zero dollars.
      ...(sources.spend !== undefined && sources.spend.entries > 0
        ? { usd: sources.spend.totalUsd }
        : {
            usdNote:
              sources.spend === undefined
                ? "nobody read the budget ledger for this campaign"
                : "the budget ledger holds no row for this campaign — work done before costs " +
                  "were attributed, or spend nobody recorded",
          }),
      durationMs: Math.max(0, campaign.updatedAt - campaign.createdAt),
      durationNote: undefined,
      source:
        sources.spend !== undefined && sources.spend.entries > 0
          ? `the budget ledger (${sources.spend.entries} entr${sources.spend.entries === 1 ? "y" : "ies"} keyed to this campaign) and the campaign's own clock`
          : "the campaign's own createdAt→updatedAt clock; no ledger row names this campaign",
    },
    ...(sources.ledgerRows === undefined ? {} : { receipts: sources.ledgerRows }),
    ...(sources.ledgerNote === undefined ? {} : { receiptsNote: sources.ledgerNote }),
  };
}

/**
 * The package as a person reads it — the report line and the CLI both render
 * from the SAME document the portal gets, so the two can never disagree.
 */
export function renderDeliveryPackage(pkg: DeliveryPackage): string {
  const mark: Record<DeliveryPieceState, string> = {
    present: "✅",
    failed: "❌",
    missing: "⚠️",
    "not-measured": "❔",
  };
  const lines: string[] = [
    `**Delivery package** — ${pkg.title} (campaign ${pkg.campaignId})`,
    `${pkg.completeness.present} of ${pkg.completeness.of} pieces present; ` +
      `${pkg.completeness.failed} failed, ${pkg.completeness.missing} missing, ${pkg.completeness.notMeasured} never measured.`,
    "",
  ];
  for (const p of pkg.pieces) {
    lines.push(`${mark[p.state]} **${p.title}** — ${p.summary}  _(${p.source})_`);
    for (const loc of p.locators ?? []) lines.push(`    - ${loc.label}: \`${loc.value}\``);
    for (const gap of p.missing ?? []) lines.push(`    - NOT MEASURED: ${gap}`);
    if (p.itemsOmitted) lines.push(`    - +${p.itemsOmitted} more item(s) not listed here`);
  }
  if (pkg.falseGreens.length > 0) {
    lines.push("", "**Greens with no proof under them** (claim → root cause):");
    for (const fg of pkg.falseGreens) lines.push(`- ${fg.claim} → ${fg.rootCause} _(${fg.source})_`);
    if (pkg.falseGreensOmitted) lines.push(`- +${pkg.falseGreensOmitted} more not listed here`);
  }
  if (pkg.receipts.length > 0) {
    lines.push("", "**Producer receipts:**", ...pkg.receipts.map((r) => `- ${r}`));
  } else if (pkg.receiptsNote) {
    lines.push("", `⚠️ ${pkg.receiptsNote}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// THE DURABLE HALF
// ---------------------------------------------------------------------------

export interface StoredDeliveryPackage {
  /** 1 for the first package this campaign stored, then 2, 3, … */
  readonly revision: number;
  readonly storedAt: number;
  /** sha256 of the stored document — two revisions with one digest are one package. */
  readonly documentSha256: string;
  readonly package: DeliveryPackage;
}

/** What the index shows without carrying a whole document. */
export interface DeliveryPackageSummary {
  readonly campaignId: string;
  readonly taskId?: string;
  readonly title: string;
  readonly revision: number;
  readonly storedAt: number;
  readonly campaignState: string;
  readonly completeness: DeliveryPackage["completeness"];
}

/**
 * WHAT THE PORTAL IS HANDED: the newest package in full, and the index of the
 * rest, so a page renders what it is given instead of assembling a delivery
 * from whatever frames it happened to receive.
 *
 * `note` is why there is no package — never silence. A store that could not be
 * opened and a machine that has never delivered anything are different
 * answers, and a card that renders nothing says neither.
 */
export interface DeliveryPackageView {
  readonly latest: DeliveryPackage | null;
  readonly latestRevision?: number;
  readonly latestStoredAt?: number;
  readonly index: readonly DeliveryPackageSummary[];
  readonly note?: string;
}

/**
 * The packages this machine holds, by campaign and revision.
 *
 * A NEW PROCESS ANSWERS FOR THE SAME CAMPAIGN: that is the whole point. The
 * chat message scrolls away and the daemon restarts; the row does not. Every
 * assembly is kept as its own revision rather than overwriting the last,
 * because the root cause of a false green a reviewer is chasing may only exist
 * in the package that recorded it — but an assembly that changed NOTHING is
 * not a new revision, so a re-sent report does not multiply the history.
 */
export class DeliveryPackageStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    configureSqlitePragmas(this.db, "identity");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_packages (
        campaign_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        task_id TEXT,
        title TEXT NOT NULL,
        campaign_state TEXT NOT NULL,
        stored_at INTEGER NOT NULL,
        document_sha256 TEXT NOT NULL,
        document_json TEXT NOT NULL,
        present INTEGER NOT NULL,
        failed INTEGER NOT NULL,
        missing INTEGER NOT NULL,
        not_measured INTEGER NOT NULL,
        piece_count INTEGER NOT NULL,
        PRIMARY KEY (campaign_id, revision)
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_delivery_packages_stored ON delivery_packages(stored_at DESC)");
  }

  /**
   * Store an assembly. Returns the row that now stands for this campaign —
   * the existing newest revision when the document is byte-identical to it.
   */
  put(pkg: DeliveryPackage, now: number = Date.now()): StoredDeliveryPackage {
    const json = JSON.stringify(pkg);
    const sha = createHash("sha256").update(json).digest("hex");
    const current = this.latest(pkg.campaignId);
    if (current !== undefined && current.documentSha256 === sha) return current;
    const revision = (current?.revision ?? 0) + 1;
    this.db
      .prepare(
        `INSERT INTO delivery_packages (
           campaign_id, revision, task_id, title, campaign_state, stored_at, document_sha256, document_json,
           present, failed, missing, not_measured, piece_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pkg.campaignId,
        revision,
        pkg.taskId ?? null,
        pkg.title,
        pkg.campaignState,
        now,
        sha,
        json,
        pkg.completeness.present,
        pkg.completeness.failed,
        pkg.completeness.missing,
        pkg.completeness.notMeasured,
        pkg.completeness.of,
      );
    return { revision, storedAt: now, documentSha256: sha, package: pkg };
  }

  /** The newest package for a campaign, or nothing. */
  latest(campaignId: string): StoredDeliveryPackage | undefined {
    const row = this.db
      .prepare(
        `SELECT revision, stored_at, document_sha256, document_json
           FROM delivery_packages WHERE campaign_id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(campaignId) as { revision: number; stored_at: number; document_sha256: string; document_json: string } | undefined;
    return row === undefined ? undefined : hydrate(row);
  }

  /** One specific revision — the one a reviewer's link names. */
  get(campaignId: string, revision: number): StoredDeliveryPackage | undefined {
    const row = this.db
      .prepare(
        `SELECT revision, stored_at, document_sha256, document_json
           FROM delivery_packages WHERE campaign_id = ? AND revision = ?`,
      )
      .get(campaignId, revision) as
      | { revision: number; stored_at: number; document_sha256: string; document_json: string }
      | undefined;
    return row === undefined ? undefined : hydrate(row);
  }

  /** Every revision this campaign has, newest first, as summaries. */
  history(campaignId: string, limit = 20): DeliveryPackageSummary[] {
    const rows = this.db
      .prepare(
        `SELECT campaign_id, task_id, title, revision, stored_at, campaign_state, present, failed, missing, not_measured, piece_count
           FROM delivery_packages WHERE campaign_id = ? ORDER BY revision DESC LIMIT ?`,
      )
      .all(campaignId, limit) as Array<Record<string, unknown>>;
    return rows.map(toSummary);
  }

  /** The newest package of every campaign, newest first — the reviewer's index. */
  index(limit = 20): DeliveryPackageSummary[] {
    const rows = this.db
      .prepare(
        `SELECT p.campaign_id, p.task_id, p.title, p.revision, p.stored_at, p.campaign_state,
                p.present, p.failed, p.missing, p.not_measured, p.piece_count
           FROM delivery_packages p
           JOIN (SELECT campaign_id, MAX(revision) AS revision FROM delivery_packages GROUP BY campaign_id) newest
             ON newest.campaign_id = p.campaign_id AND newest.revision = p.revision
          ORDER BY p.stored_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(toSummary);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * A document this process cannot parse is NOT a package.
 *
 * A row written by a newer schema, or one that was truncated, must not
 * hydrate into a half-package that renders as a delivery: the reader is told
 * the row is unreadable instead (the same rule the coverage queue learned,
 * Codex 2026-09-12 AD#18).
 */
function hydrate(row: { revision: number; stored_at: number; document_sha256: string; document_json: string }): StoredDeliveryPackage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.document_json);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const doc = parsed as Partial<DeliveryPackage>;
  if (doc.schemaVersion !== 1 || typeof doc.campaignId !== "string" || !Array.isArray(doc.pieces)) return undefined;
  return {
    revision: row.revision,
    storedAt: row.stored_at,
    documentSha256: row.document_sha256,
    package: doc as DeliveryPackage,
  };
}

function toSummary(r: Record<string, unknown>): DeliveryPackageSummary {
  return {
    campaignId: String(r["campaign_id"]),
    ...(r["task_id"] === null || r["task_id"] === undefined ? {} : { taskId: String(r["task_id"]) }),
    title: String(r["title"]),
    revision: Number(r["revision"]),
    storedAt: Number(r["stored_at"]),
    campaignState: String(r["campaign_state"]),
    completeness: {
      of: Number(r["piece_count"]),
      present: Number(r["present"]),
      failed: Number(r["failed"]),
      missing: Number(r["missing"]),
      notMeasured: Number(r["not_measured"]),
    },
  };
}
