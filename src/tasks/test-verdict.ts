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
 * The LAST test-run observation wins: a run that went red then was fixed and
 * re-run green is green; a run that ended red is red no matter what earlier
 * runs said.
 */
export function deriveTestVerdict(evidence: readonly TestEvidence[]): TaskTestVerdict {
  let verdict: TaskTestVerdict = { detail: "" };
  for (const item of evidence) {
    const text = typeof item.content === "string" ? item.content : "";
    const match = TEST_RUN_RE.exec(text);
    if (!match) continue;
    const line =
      text
        .split("\n")
        .find((l) => TEST_RUN_RE.test(l))
        ?.trim()
        .slice(0, 200) ?? match[0];
    const red = item.isError === true || RED_RE.test(text);
    verdict = { testsGreen: !red, detail: line };
  }
  return verdict;
}
