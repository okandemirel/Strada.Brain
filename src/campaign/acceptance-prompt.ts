/**
 * The GDD rows a sprint is judged on, in the prompt it is submitted with
 * (GDD-drift plan W10, M3).
 *
 * In campaign 18d4t no sprint was shown the GDD sentences its milestone would
 * be judged on. It was told its "deliverables" were what it would be
 * measured against (nothing read them), and it graded itself with its own
 * tests. Once the scope gate runs, a milestone is decided by system-written
 * checks of its own GDD rows; a worker that never sees those rows builds to
 * its own reading of the document and finds out at the bounce.
 *
 * Pure: the caller passes the ledger, the milestone and the mode.
 */

import { ACCEPTANCE_DIR, type RequirementLedger, type RequirementRow, type ScopeGateMode } from "./scope-types.js";
import { rowDecides } from "./scope-verdict.js";
import type { CampaignMilestone } from "./types.js";

export const ACCEPTANCE_BLOCK_OPEN = "<<ACCEPTANCE — GDD rules this sprint is judged on>>";
export const ACCEPTANCE_BLOCK_CLOSE = "<</ACCEPTANCE>>";
/** The whole block, markers included. */
export const ACCEPTANCE_BLOCK_MAX_CHARS = 6_000;
/**
 * The line a worker writes to contest a check: `ACCEPTANCE DISPUTE <test name
 * or row id>: <reason>`, among the last lines of its report. The prompt
 * teaches this grammar; the settle path's parser reads it.
 */
export const ACCEPTANCE_DISPUTE_PREFIX = "ACCEPTANCE DISPUTE";

const FAILURE_MESSAGE_CHARS = 200;
/** A row is a GDD sentence; a paragraph-long one is cut so one row cannot spend the whole block. */
const ROW_TEXT_CHARS = 500;
/** Kept for the line that names the rows past the cap, so they are listed rather than dropped. */
const OVERFLOW_RESERVE = 800;

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  const one = flat(text);
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * The rows this milestone is judged on, in the order the milestone lists them.
 * A row it lists stays unless the row itself names another owner (a time-box
 * split moved it); a row naming this milestone counts even when the list
 * missed it. Showing one row too many costs a sentence; hiding a row the
 * sprint is judged on is the defect this block exists to close.
 */
export function rowsJudgedFor(
  ledger: RequirementLedger,
  milestone: Pick<CampaignMilestone, "id" | "requirementIds">,
): RequirementRow[] {
  const byRid = new Map(ledger.rows.map((r) => [r.rid, r] as const));
  const out: RequirementRow[] = [];
  const seen = new Set<string>();
  const take = (row: RequirementRow | undefined): void => {
    if (!row || seen.has(row.rid)) return;
    if (row.owner !== undefined && row.owner !== milestone.id) return;
    // The judge's own rule, so the sprint is shown the rows it is judged on.
    if (!rowDecides(row)) return;
    seen.add(row.rid);
    out.push(row);
  };
  for (const rid of milestone.requirementIds ?? []) take(byRid.get(rid));
  for (const row of ledger.rows) if (row.owner === milestone.id) take(row);
  return out;
}

/**
 * What the last verdict could not observe, per row: the `row-unbound`
 * reasons, whose detail is the observable the test writer asked for.
 */
export function unboundRowsOf(milestone: Pick<CampaignMilestone, "scopeVerdict">): Map<string, string> {
  const out = new Map<string, string>();
  for (const reason of milestone.scopeVerdict?.reasons ?? []) {
    if (reason.code === "row-unbound" && reason.rid !== undefined && !out.has(reason.rid)) {
      out.set(reason.rid, clip(reason.detail, FAILURE_MESSAGE_CHARS));
    }
  }
  return out;
}

/** Failing first, then rows with nothing that passes yet, then passing ones: a cut takes the least actionable. */
function urgency(row: RequirementRow): number {
  const outcome = row.last?.outcome;
  if (outcome === "fail") return 0;
  if (outcome === undefined) return 2;
  if (outcome === "pass") return 3;
  return 1;
}

function currentTestName(row: RequirementRow): string | undefined {
  for (const check of row.checks) {
    if (check.kind === "test" && check.supersededAtMs === undefined) return check.testName;
  }
  return undefined;
}

function rowId(row: RequirementRow): string {
  return row.label ? `${row.label} (${row.rid})` : row.rid;
}

function renderRow(row: RequirementRow, unbound: ReadonlyMap<string, string>, gddSaved: boolean): string {
  // A line number locates a row only in a file that holds the GDD; without
  // one, a worker took it to whatever design document the repo held.
  const where = gddSaved ? `"${flat(row.section)}", GDD line ${row.line}` : `"${flat(row.section)}"`;
  const head = `- ${rowId(row)} · ${where}: "${clip(row.text, ROW_TEXT_CHARS)}"`;
  const facts: string[] = [];
  const test = currentTestName(row);
  if (test !== undefined) facts.push(`test ${test}`);
  const last = row.last;
  if (last === undefined) {
    facts.push("last: not measured yet");
  } else {
    const said = last.outcome === "pass" ? "" : clip(last.detail, FAILURE_MESSAGE_CHARS);
    facts.push(`last: ${last.outcome} on ${last.revision.slice(0, 8)}${said ? ` — ${said}` : ""}`);
  }
  const expose = unbound.get(row.rid);
  if (expose !== undefined) facts.push(`expose: ${expose}`);
  return `${head}\n  ${facts.join(" · ")}`;
}

/** "N more row(s)" with as many ids as fit in `room`, so a cut row is named, not dropped. */
function overflowLine(rows: readonly RequirementRow[], room: number): string {
  const lead = `Not shown, for length: ${rows.length} more row(s) — `;
  const ids = rows.map((r) => r.label ?? r.rid);
  const render = (n: number): string =>
    n === ids.length ? `${lead}${ids.join(", ")}.` : `${lead}${[...ids.slice(0, n), `… and ${ids.length - n} more`].join(", ")}.`;
  let n = 0;
  let used = lead.length;
  while (n < ids.length && used + ids[n]!.length + 2 <= room) {
    used += ids[n]!.length + 2;
    n += 1;
  }
  while (n > 0 && render(n).length > room) n -= 1;
  return render(n);
}

/**
 * The block, or "" when the gate is off or the milestone is judged on no rows.
 * Off mode never reaches the ledger, so a campaign with the gate off is
 * submitted with exactly the prompt it had.
 */
export function acceptanceBlock(input: {
  readonly mode: ScopeGateMode;
  readonly rows: readonly RequirementRow[];
  /** The campaign's GDD file; undefined when no file in the project holds the GDD (a text-only campaign). */
  readonly gddPath: string | undefined;
  readonly unbound?: ReadonlyMap<string, string>;
  readonly maxChars?: number;
}): string {
  if (input.mode === "off" || input.rows.length === 0) return "";
  const unbound = input.unbound ?? new Map<string, string>();
  const max = input.maxChars ?? ACCEPTANCE_BLOCK_MAX_CHARS;
  const where =
    input.mode === "on"
      ? `The checks are committed in ${ACCEPTANCE_DIR}/ by the system. Run them as you like; never edit, move or delete ` +
        "anything in that folder: it is read-only and system-owned, the write-back refuses any change there, and a " +
        "changed file is restored and counted against the sprint."
      : `The system writes the checks to ${ACCEPTANCE_DIR}/ and runs them itself when the sprint settles, so they are ` +
        "not in your workspace. That folder is read-only and system-owned: the write-back refuses any change there.";
  const gddSaved = input.gddPath !== undefined;
  const head = [
    ACCEPTANCE_BLOCK_OPEN,
    "The system judges this milestone on the GDD rows below, in the GDD's own words. A row closes only when its " +
      "system-written acceptance check passes on the committed tree, and every row that passed before must still pass. " +
      "Your own tests do not close rows.",
    // The same notice a text-only gap sprint carries (gapSprint).
    ...(gddSaved
      ? []
      : [
          "This campaign's GDD is not saved in the project, so no file holds it — do not look for one: a design " +
            "document in the repo is another document.",
        ]),
    where,
  ].join("\n");
  const tailLines: string[] = [];
  if (input.rows.some((r) => unbound.has(r.rid))) {
    tailLines.push(
      'A row marked "expose:" is one its check cannot observe through the project\'s public code yet: make that ' +
        "observable (a public property, an event, a service query) so the row can be measured.",
    );
  }
  tailLines.push(
    `If a check contradicts the GDD sentence it quotes, end your final report with one line per check: ` +
      `${ACCEPTANCE_DISPUTE_PREFIX} <test name or row id>: <why>. A dispute is reviewed; it never passes the row by itself.`,
    ACCEPTANCE_BLOCK_CLOSE,
  );
  const tail = tailLines.join("\n");

  const ordered = input.rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => urgency(a.row) - urgency(b.row) || a.i - b.i)
    .map(({ row }) => row);
  const rendered = ordered.map((row) => renderRow(row, unbound, gddSaved));
  const fixed = head.length + tail.length + 2;
  const fits = (budget: number): number => {
    let used = 0;
    let n = 0;
    for (const entry of rendered) {
      if (used + entry.length + 1 > budget) break;
      used += entry.length + 1;
      n += 1;
    }
    return n;
  };
  let shown = fits(max - fixed);
  const lines = [head];
  if (shown === rendered.length) {
    lines.push(...rendered);
  } else {
    shown = fits(Math.max(0, max - fixed - OVERFLOW_RESERVE));
    lines.push(...rendered.slice(0, shown), overflowLine(ordered.slice(shown), OVERFLOW_RESERVE - 1));
  }
  lines.push(tail);
  return lines.join("\n");
}

/**
 * The block for this milestone's next submit, with its leading separator, or
 * "" (gate off, no readable ledger, no rows).
 */
export function acceptancePromptFor(
  campaign: { readonly requirements?: RequirementLedger; readonly gddPath?: string },
  milestone: Pick<CampaignMilestone, "id" | "requirementIds" | "scopeVerdict">,
  mode: ScopeGateMode,
): string {
  if (mode === "off" || campaign.requirements === undefined) return "";
  const block = acceptanceBlock({
    mode,
    rows: rowsJudgedFor(campaign.requirements, milestone),
    gddPath: campaign.gddPath,
    unbound: unboundRowsOf(milestone),
  });
  return block === "" ? "" : `\n\n${block}`;
}
