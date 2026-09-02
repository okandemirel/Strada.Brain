/**
 * Structured test verdict derived from a run's tool evidence.
 *
 * Audited 2026-08-29: verification results died at the task boundary — Task
 * carried only prose, so the campaign judged "green" from the agent's own
 * report wording. This derives a mechanical verdict from what the test tools
 * actually printed, and rides on the Task row for any settle-side consumer.
 */

export interface TaskTestVerdict {
  /** undefined = no test run observed in the evidence. */
  testsGreen?: boolean;
  /** The line the verdict was read from (empty when no run observed). */
  detail: string;
}

/** A tool observation: result text plus the tool-level error flag if known. */
export interface TestEvidence {
  content: string;
  isError?: boolean;
}

const TEST_RUN_RE =
  /(PlayMode|EditMode) verification (FAILED|passed)|(\d+) of (\d+) tests? failed|All (\d+) tests? passed/i;
const RED_RE = /verification FAILED|\d+ of \d+ tests? failed/i;

/**
 * EVERY test-run line in `text`, in the order printed (each trimmed and capped
 * at 200 chars); `[]` when the text holds no test-run observation.
 *
 * Audited 2026-09-02: the verdict read only the FIRST matching line. A Unity
 * run that prints its EditMode pass before its PlayMode failure therefore
 * produced testsGreen=false with detail "EditMode verification passed" — a
 * verdict whose own words contradicted it, and which the campaign quoted
 * verbatim as "Tests were RED at completion: EditMode verification passed".
 * Exported so a producer that must truncate a tool's output can keep these
 * lines intact.
 */
export function findTestRunLines(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const lines = text
    .split("\n")
    .filter((l) => TEST_RUN_RE.test(l))
    .map((l) => l.trim().slice(0, 200));
  if (lines.length > 0) return lines;
  // A body with no newline the match sits on (a single-line blob) still yields
  // the matched fragment rather than "no run observed".
  const match = TEST_RUN_RE.exec(text);
  return match ? [match[0].slice(0, 200)] : [];
}

/**
 * ACROSS tool results the LAST observation wins: a run that went red then was
 * fixed and re-run green is green; a run that ended red is red no matter what
 * earlier runs said.
 *
 * WITHIN one tool result there is no chronology — one call is one observation,
 * and a re-run is always a separate call. A combined report may print its
 * PlayMode failure before its EditMode pass, so a red line anywhere in the body
 * makes the whole observation red (audited 2026-09-02: reading only the last
 * line here would turn exactly that report into a false green). What the last
 * observation wins is the DETAIL: the verdict names the last RED line when it
 * is red, the last green line when it is green, and says so explicitly when the
 * only thing red is the tool's own error flag.
 */
export function deriveTestVerdict(evidence: readonly TestEvidence[]): TaskTestVerdict {
  let verdict: TaskTestVerdict = { detail: "" };
  for (const item of evidence) {
    const text = typeof item.content === "string" ? item.content : "";
    const lines = findTestRunLines(text);
    if (lines.length === 0) continue;
    const redLines = lines.filter((l) => RED_RE.test(l));
    const lastLine = lines[lines.length - 1]!;
    const red = item.isError === true || redLines.length > 0;
    const detail = redLines.length > 0
      ? redLines[redLines.length - 1]!
      : red
        ? `${lastLine} (tool reported an error)`
        : lastLine;
    verdict = { testsGreen: !red, detail };
  }
  return verdict;
}
