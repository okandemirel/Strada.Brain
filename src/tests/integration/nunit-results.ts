/**
 * Reading whether a Unity test run actually passed.
 *
 * Two things made the fixture's verdict unfounded. The command passed `-quit`
 * alongside `-runTests`, so the Editor quit on its own schedule and returned 0
 * regardless of what the tests did; and the assertion was
 * `results.toContain("Passed")`, which every run with at least one passing test
 * satisfies — including a run where the rest failed.
 *
 * The counts are on the top-level <test-run> element. Read those.
 */

export interface TestRunOutcome {
  readonly result: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
}

/**
 * The counts NUnit writes on the top-level <test-run> element, or null when
 * there is no such element — a run that wrote no results did not pass, and the
 * caller can say so with the file's own text attached.
 */
export function parseTestRun(xml: string): TestRunOutcome | null {
  const element = /<test-run\b[^>]*>/.exec(xml)?.[0];
  if (!element) return null;

  const attr = (name: string): string | null =>
    new RegExp(`\\b${name}="([^"]*)"`).exec(element)?.[1] ?? null;
  const count = (name: string): number => Number.parseInt(attr(name) ?? "", 10) || 0;

  return {
    result: attr("result") ?? "",
    total: count("total"),
    passed: count("passed"),
    failed: count("failed"),
  };
}
