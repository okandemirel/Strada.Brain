/**
 * Parses a .NET TRX test report into the outcome map resolution scoring needs.
 *
 * `dotnet test --logger trx` is how a C# suite reports results, so this is the
 * bridge between running a SWE-Sharp-Bench task and scoring it. It is
 * deliberately a separate, tested function rather than logic inside a runner
 * script: a parser that quietly returns an empty map turns "nothing ran" into
 * "nothing failed", and scoring treats absent tests as failures precisely
 * because of that.
 *
 * This is attribute extraction over the UnitTestResult elements, not a general
 * XML parser. That is a deliberate limit — the format is fixed and adding an
 * XML dependency to read four attributes is not worth it — but it means a TRX
 * with the results nested differently would parse as empty, which is why
 * `parseTrx` reports whether it found the results element at all.
 */

export type TestOutcome = "passed" | "failed" | "skipped";

export interface TrxParseResult {
  readonly outcomes: Map<string, TestOutcome>;
  /**
   * False when the file contained no <Results> section — meaning the run
   * produced no results rather than a run in which nothing passed. The caller
   * must not read that as "all tests failed cleanly"; it usually means the
   * build failed.
   */
  readonly hasResults: boolean;
  readonly counters?: { total: number; passed: number; failed: number };
}

/**
 * TRX outcome values. `NotExecuted` covers both skipped and
 * blocked-by-a-failed-dependency, and neither is a pass.
 */
const OUTCOME_MAP: Record<string, TestOutcome> = {
  Passed: "passed",
  Failed: "failed",
  Error: "failed",
  Timeout: "failed",
  Aborted: "failed",
  NotExecuted: "skipped",
  Inconclusive: "skipped",
  Warning: "skipped",
  Pending: "skipped",
};

const UNIT_TEST_RESULT = /<UnitTestResult\b([^>]*?)\/?>/g;
const COUNTERS = /<Counters\b([^>]*?)\/?>/;

function attr(tag: string, name: string): string | undefined {
  // Attribute values in TRX are double-quoted and XML-escaped.
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return match?.[1] === undefined ? undefined : unescapeXml(match[1]);
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last, so "&amp;lt;" becomes "&lt;" rather than "<".
    .replace(/&amp;/g, "&");
}

export function parseTrx(xml: string): TrxParseResult {
  const outcomes = new Map<string, TestOutcome>();
  let found = false;

  UNIT_TEST_RESULT.lastIndex = 0;
  for (let m = UNIT_TEST_RESULT.exec(xml); m !== null; m = UNIT_TEST_RESULT.exec(xml)) {
    found = true;
    const tag = m[1]!;
    const name = attr(tag, "testName");
    const rawOutcome = attr(tag, "outcome");
    if (!name) continue;

    // An unrecognised outcome is treated as failure, never as a pass: a new
    // TRX status should make a run look worse and get investigated, not
    // silently count as green.
    const outcome = rawOutcome ? (OUTCOME_MAP[rawOutcome] ?? "failed") : "failed";

    // Data-driven tests emit one row per case under a shared name. The test as
    // a whole passes only if every case did.
    const existing = outcomes.get(name);
    outcomes.set(name, existing === undefined ? outcome : worst(existing, outcome));
  }

  const counterTag = COUNTERS.exec(xml)?.[1];
  const counters = counterTag
    ? {
        total: Number(attr(counterTag, "total") ?? 0),
        passed: Number(attr(counterTag, "passed") ?? 0),
        failed: Number(attr(counterTag, "failed") ?? 0),
      }
    : undefined;

  return { outcomes, hasResults: found, ...(counters ? { counters } : {}) };
}

/** failed beats skipped beats passed. */
function worst(a: TestOutcome, b: TestOutcome): TestOutcome {
  if (a === "failed" || b === "failed") return "failed";
  if (a === "skipped" || b === "skipped") return "skipped";
  return "passed";
}

/**
 * Matches a required test name against what the suite reported.
 *
 * The dataset lists fully-qualified names
 * (`Ns.Class.Method`), while TRX `testName` is sometimes just the method, and
 * data-driven cases append arguments (`Method(a: 1)`). An exact-only match
 * would score correct runs as failures, so a required name also matches a
 * reported name that is its suffix at a dot boundary, or that adds a
 * parenthesised argument list.
 */
export function findOutcome(
  outcomes: ReadonlyMap<string, TestOutcome>,
  requiredName: string,
): TestOutcome | undefined {
  const exact = outcomes.get(requiredName);
  if (exact !== undefined) return exact;

  let best: TestOutcome | undefined;
  for (const [name, outcome] of outcomes) {
    const base = name.replace(/\(.*\)$/, "");
    const matches =
      base === requiredName ||
      requiredName.endsWith(`.${base}`) ||
      base.endsWith(`.${requiredName}`);
    if (!matches) continue;
    best = best === undefined ? outcome : worst(best, outcome);
  }
  return best;
}
