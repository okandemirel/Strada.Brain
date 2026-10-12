/**
 * The independent delivery review's findings, as data the scope gate acts on
 * (GDD-drift plan W13).
 *
 * The review was prose a person read: a reviewer that saw a system check
 * asserting a literal, or a GDD rule no row states, changed nothing — the weak
 * check went on closing its row and the missing rule never held delivery. Its
 * answer now ends with a JSON tail,
 *
 *   {"weakChecks":[{"rid","why"}],"missing":[{"gddQuote","why"}]}
 *
 * and only two things follow from it:
 *
 *   • a weak check on a known row with a current system test marks that test
 *     weak and retires it, so the writer replaces it once with the reviewer's
 *     reason (`weak`) as the problem. A passing row reopens: open, its last
 *     result dropped, so only the new test passing on a measured revision
 *     closes it again (`closesByLedger`). Any other row keeps its status and
 *     its last result: none of them rested on the weak check's pass;
 *   • a missing item whose quote is in the APPROVED GDD verbatim becomes a new
 *     row, source `review-added`, queued with no owner.
 *
 * Everything else is disclosed and changes nothing. The review never closes,
 * removes or reclassifies a row, and its VERDICT line decides nothing.
 *
 * Pure: the caller passes the ledger, the approved text and the clock.
 */

import { createHash } from "node:crypto";
import type { ReviewRow } from "../agents/review/codex-second-opinion.js";
import { rowsFromQuotes } from "./requirement-rows.js";
import { rowRef } from "./scope-report.js";
import { rowDecides } from "./scope-verdict.js";
import type { RequirementLedger, RequirementRow } from "./scope-types.js";

/** One review may add at most this many rows; a reviewer that lists the whole document is disclosed past it. */
export const REVIEW_MAX_ADDED_ROWS = 10;

export interface ReviewWeakCheck {
  readonly rid: string;
  readonly why: string;
}

export interface ReviewMissing {
  readonly gddQuote: string;
  readonly why: string;
}

export interface ReviewFindings {
  /** Whether the answer ended with a findings object at all. */
  readonly found: boolean;
  readonly weakChecks: readonly ReviewWeakCheck[];
  readonly missing: readonly ReviewMissing[];
  /** Entries of neither shape, as the reviewer wrote them. */
  readonly unreadable: readonly string[];
}

export interface ReviewApplication {
  /** The ledger with the findings applied; the one passed in when nothing changed. */
  readonly ledger: RequirementLedger;
  readonly reopened: readonly RequirementRow[];
  readonly added: readonly RequirementRow[];
  /** Findings that changed nothing, each with why. */
  readonly disclosed: readonly string[];
}

/**
 * What the gate did with one review, for the delivery decision: the rows it
 * reopened or added are open GDD rows — missing proofs on the existing budget
 * path. Zero when the review did not run; a review that did not run blocks
 * nothing.
 */
export interface ReviewGateOutcome {
  readonly reopened: readonly string[];
  readonly added: readonly string[];
  readonly disclosed: readonly string[];
  /** reopened + added. */
  readonly changed: number;
}

/** What the gate did, in a person's words, stored beside the reviewer's verbatim answer. */
export interface ReviewGateRecord {
  reopened: string[];
  added: string[];
  disclosed: string[];
  /** Shadow records what the findings would hold and decides nothing. */
  mode: "shadow" | "on";
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const TAIL_START_RE = /\{\s*"(?:weakChecks|missing)"\s*:/g;

function readFindings(parsed: Record<string, unknown>): ReviewFindings {
  const weakChecks: ReviewWeakCheck[] = [];
  const missing: ReviewMissing[] = [];
  const unreadable: string[] = [];
  const entries = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);
  const why = (entry: Record<string, unknown>): string => (typeof entry["why"] === "string" ? entry["why"] : "");
  for (const entry of entries(parsed["weakChecks"])) {
    const rid = isRecord(entry) ? entry["rid"] : undefined;
    if (isRecord(entry) && typeof rid === "string" && rid.trim() !== "") {
      weakChecks.push({ rid: rid.trim(), why: why(entry) });
    } else {
      unreadable.push(`weakChecks: ${JSON.stringify(entry)}`);
    }
  }
  for (const entry of entries(parsed["missing"])) {
    const quote = isRecord(entry) ? entry["gddQuote"] : undefined;
    if (isRecord(entry) && typeof quote === "string" && quote.trim() !== "") {
      missing.push({ gddQuote: quote, why: why(entry) });
    } else {
      unreadable.push(`missing: ${JSON.stringify(entry)}`);
    }
  }
  return { found: true, weakChecks, missing, unreadable };
}

/**
 * The findings tail of a review's answer: the LAST object that opens with
 * `weakChecks` or `missing`, fenced or not. Prose before it is the reviewer's
 * and is not read here. No tail is `found: false`, which changes nothing.
 */
export function parseReviewFindings(text: string): ReviewFindings {
  const starts = [...(text ?? "").matchAll(TAIL_START_RE)].map((m) => m.index!).reverse();
  for (const start of starts) {
    for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        continue;
      }
      if (isRecord(parsed)) return readFindings(parsed);
    }
  }
  return { found: false, weakChecks: [], missing: [], unreadable: [] };
}

/** The rows a review prompt lists: the ones that can block, with their current system test. */
export function reviewRowsOf(ledger: RequirementLedger): ReviewRow[] {
  return ledger.rows.filter(rowDecides).map((row) => {
    const test = row.checks.find((c) => c.kind === "test" && c.supersededAtMs === undefined);
    return {
      rid: row.rid,
      ...(row.label === undefined ? {} : { label: row.label }),
      where: row.sectionNumber ? `§${row.sectionNumber}` : row.section,
      text: row.text,
      ...(test?.kind === "test" ? { test: test.testName } : {}),
    };
  });
}

function whyNeverBlocks(row: RequirementRow): string {
  if (row.status === "waived") return "a person waived it";
  if (row.status === "excluded") return clip(row.excludedBecause ?? "it is excluded", 120);
  return row.kind === "aspiration" ? "an aspiration" : "look and feel";
}

/** A label names a row only when exactly one row carries it. */
function rowIndexOf(rows: readonly RequirementRow[], named: string): number | undefined {
  const byRid = rows.findIndex((r) => r.rid === named);
  if (byRid >= 0) return byRid;
  const byLabel = rows.flatMap((r, i) => (r.label === named ? [i] : []));
  return byLabel.length === 1 ? byLabel[0] : undefined;
}

/**
 * Apply a review's findings to the ledger. Only two changes are possible —
 * a weak check retires its test (and reopens its row when it was passing), a
 * verbatim quote adds a queued row — and neither can close anything. A second weak call on a row in the same review
 * finds its test already retired, so a row is regenerated at most once per
 * review. A missing item is read only against the text the ledger was read
 * from; with an amendment not yet re-read, it is disclosed instead.
 */
export function applyReviewFindings(
  ledger: RequirementLedger,
  findings: ReviewFindings,
  options: { readonly gddText: string | undefined; readonly atMs: number },
): ReviewApplication {
  const disclosed: string[] = findings.unreadable.map((u) => `unreadable finding: ${clip(u, 160)}`);
  if (!findings.found) disclosed.push("the review ended with no findings object, so it reopened and added nothing");
  const rows = [...ledger.rows];
  const reopened: RequirementRow[] = [];
  for (const finding of findings.weakChecks) {
    const said = `weak check on "${clip(finding.rid, 60)}"`;
    const at = rowIndexOf(rows, finding.rid);
    if (at === undefined) {
      disclosed.push(`${said}: no GDD row has that id`);
      continue;
    }
    const row = rows[at]!;
    if (!rowDecides(row)) {
      disclosed.push(`${said} (${rowRef(row)}): the row never blocks (${whyNeverBlocks(row)})`);
      continue;
    }
    if (!row.checks.some((c) => c.kind === "test" && c.supersededAtMs === undefined)) {
      const retired = row.checks.some((c) => c.kind === "test" && c.weak !== undefined && c.supersededAtMs === options.atMs);
      disclosed.push(`${said} (${rowRef(row)}): it has no current system test${retired ? " (this review already retired it)" : ""}`);
      continue;
    }
    const why = clip(finding.why, 300) || "the independent review gave no reason";
    const checks = row.checks.map((c) => (c.kind === "test" && c.supersededAtMs === undefined ? { ...c, weak: why, supersededAtMs: options.atMs } : c));
    // Only a pass rests on the check called weak. A failing row keeps its
    // failure message, a check-fault row the person who decides it, an
    // unmeasured row its own path; resetting them to open would reclassify.
    const { last: _measuredWithIt, ...rest } = row;
    const open: RequirementRow = row.status === "passing" ? { ...rest, status: "open", checks } : { ...row, checks };
    rows[at] = open;
    reopened.push(open);
  }

  const added: RequirementRow[] = [];
  const quotes = findings.missing.map((m) => m.gddQuote);
  const text = options.gddText;
  if (quotes.length > 0 && (text === undefined || createHash("sha256").update(text).digest("hex") !== ledger.gddSha256)) {
    disclosed.push(
      `${quotes.length} missing item(s) not read: the rows were read from another text than the approved GDD (an amendment not yet re-read), ` +
        `so a quote could not be placed among them: ${clip(quotes.join(" | "), 200)}`,
    );
  } else if (quotes.length > 0) {
    const read = rowsFromQuotes(text!, quotes, rows, { gddSha256: ledger.gddSha256, gddRevision: ledger.gddRevision, source: "review-added" });
    for (const r of read.rejected) disclosed.push(`missing "${clip(r.quote, 100)}": ${r.reason}`);
    for (const row of read.added) {
      if (!rowDecides(row)) {
        disclosed.push(`missing "${clip(row.text, 100)}": a row that never blocks (${whyNeverBlocks(row)})`);
      } else if (added.length >= REVIEW_MAX_ADDED_ROWS) {
        disclosed.push(`missing "${clip(row.text, 100)}": past the ${REVIEW_MAX_ADDED_ROWS} rows one review may add`);
      } else {
        added.push(row);
      }
    }
  }

  if (reopened.length + added.length === 0) return { ledger, reopened, added, disclosed };
  return { ledger: { ...ledger, rows: [...rows, ...added] }, reopened, added, disclosed };
}

/** What the gate did, in a person's words: rows by their GDD label and section. */
export function reviewGateRecord(applied: ReviewApplication, mode: "shadow" | "on"): ReviewGateRecord {
  return {
    mode,
    reopened: applied.reopened.map((row) => {
      // The newest: a test an earlier review retired may still be listed before it.
      const weak = [...row.checks].reverse().find((c) => c.kind === "test" && c.weak !== undefined);
      const kept = row.status === "open" ? "" : ` (stays ${row.status})`;
      return `${rowRef(row)}${kept}${weak?.kind === "test" ? ` — ${clip(weak.weak ?? "", 160)}` : ""}`;
    }),
    added: applied.added.map((row) => `${rowRef(row)} — "${clip(row.text, 160)}"`),
    disclosed: [...applied.disclosed],
  };
}

/** The outcome of a review that changed nothing, with why. */
export function reviewGateUnchanged(...why: string[]): ReviewGateOutcome {
  return { reopened: [], added: [], disclosed: why, changed: 0 };
}

/** The outcome the delivery decision reads: row ids. */
export function reviewGateOutcome(applied: ReviewApplication): ReviewGateOutcome {
  return {
    reopened: applied.reopened.map((r) => r.rid),
    added: applied.added.map((r) => r.rid),
    disclosed: applied.disclosed,
    changed: applied.reopened.length + applied.added.length,
  };
}
