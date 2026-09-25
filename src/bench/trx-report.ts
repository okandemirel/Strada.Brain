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
 * This is attribute extraction over the UnitTestResult and UnitTest elements,
 * not a general XML parser. That is a deliberate limit — the format is fixed
 * and adding an XML dependency to read a handful of attributes is not worth it
 * — but it means a TRX with the results nested differently would parse as
 * empty, which is why `parseTrx` reports whether it found the results element
 * at all.
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
  /**
   * Bare method names that more than one distinct test reported, with no
   * class to tell them apart. Such a name cannot stand in for any one
   * fully-qualified required test.
   */
  readonly ambiguousNames?: ReadonlySet<string>;
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
// A non-self-closing <UnitTest> definition; `(?<!\/)` keeps a self-closing one
// from swallowing the next definition's TestMethod.
const UNIT_TEST_DEFINITION = /<UnitTest\b([^>]*?)(?<!\/)>([\s\S]*?)<\/UnitTest>/g;
const TEST_METHOD = /<TestMethod\b([^>]*?)\/?>/;

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

/** The method name without a data-driven argument list. */
function stripArgs(name: string): string {
  return name.replace(/\(.*\)$/s, "");
}

/** A bare method name, e.g. `Parse` or `Parse(a: 1)`, with no class in it. */
function isShortName(name: string): boolean {
  return !stripArgs(name).includes(".");
}

/**
 * testId → declaring class, from TestDefinitions/UnitTest/TestMethod@className.
 * MSTest can write an assembly-qualified class ("Ns.C, Asm, Version=…"); only
 * the type name is kept.
 */
function readTestClasses(xml: string): Map<string, string> {
  const classes = new Map<string, string>();
  UNIT_TEST_DEFINITION.lastIndex = 0;
  for (let m = UNIT_TEST_DEFINITION.exec(xml); m !== null; m = UNIT_TEST_DEFINITION.exec(xml)) {
    const id = attr(m[1]!, "id");
    const methodTag = TEST_METHOD.exec(m[2]!)?.[1];
    const className = methodTag ? attr(methodTag, "className")?.split(",")[0]?.trim() : undefined;
    if (id && className) classes.set(id, className);
  }
  return classes;
}

export function parseTrx(xml: string): TrxParseResult {
  const outcomes = new Map<string, TestOutcome>();
  const classes = readTestClasses(xml);
  // Bare name → the distinct testIds that reported it. Cases of one
  // data-driven test share a testId; two classes' same-named methods do not.
  const shortNameIds = new Map<string, Set<string>>();
  let found = false;

  UNIT_TEST_RESULT.lastIndex = 0;
  for (let m = UNIT_TEST_RESULT.exec(xml); m !== null; m = UNIT_TEST_RESULT.exec(xml)) {
    found = true;
    const tag = m[1]!;
    const reported = attr(tag, "testName");
    const rawOutcome = attr(tag, "outcome");
    if (!reported) continue;

    // MSTest and NUnit report only the method name. Qualify it with the class
    // from the test definition, so a same-named test in another class cannot
    // stand in for a required test that never ran.
    const testId = attr(tag, "testId");
    const className = testId ? classes.get(testId) : undefined;
    const name = className && isShortName(reported) ? `${className}.${reported}` : reported;
    if (testId && isShortName(name)) {
      const ids = shortNameIds.get(name) ?? new Set<string>();
      ids.add(testId);
      shortNameIds.set(name, ids);
    }

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

  const ambiguousNames = new Set(
    [...shortNameIds].filter(([, ids]) => ids.size > 1).map(([name]) => name),
  );

  return {
    outcomes,
    hasResults: found,
    ...(counters ? { counters } : {}),
    ...(ambiguousNames.size > 0 ? { ambiguousNames } : {}),
  };
}

/** failed beats skipped beats passed. */
function worst(a: TestOutcome, b: TestOutcome): TestOutcome {
  if (a === "failed" || b === "failed") return "failed";
  if (a === "skipped" || b === "skipped") return "skipped";
  return "passed";
}

export interface FindOutcomeContext {
  /** Every test name being scored, so a bare reported name can be checked for uniqueness. */
  readonly requiredNames?: readonly string[];
  /** Bare names that more than one distinct test reported (`TrxParseResult.ambiguousNames`). */
  readonly ambiguousNames?: ReadonlySet<string>;
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
 *
 * A bare method name carries no class, so it counts only when it is unique:
 * no other required name ends in the same method, and only one test reported
 * it. Otherwise another class's same-named test could stand in for a required
 * test that never ran. `parseTrx` qualifies bare names from the TRX test
 * definitions, so this fallback only applies to reports without them.
 */
export function findOutcome(
  outcomes: ReadonlyMap<string, TestOutcome>,
  requiredName: string,
  context: FindOutcomeContext = {},
): TestOutcome | undefined {
  const exact = outcomes.get(requiredName);
  if (exact !== undefined) return exact;

  let best: TestOutcome | undefined;
  for (const [name, outcome] of outcomes) {
    const base = stripArgs(name);
    const matches =
      base === requiredName ||
      requiredName.endsWith(`.${base}`) ||
      base.endsWith(`.${requiredName}`);
    if (!matches) continue;
    if (base !== requiredName && isShortName(base) && !isUniqueShortMatch(name, base, requiredName, context)) {
      continue;
    }
    best = best === undefined ? outcome : worst(best, outcome);
  }
  return best;
}

function isUniqueShortMatch(
  name: string,
  base: string,
  requiredName: string,
  context: FindOutcomeContext,
): boolean {
  if (context.ambiguousNames?.has(name)) return false;
  return !(context.requiredNames ?? []).some(
    (other) => other !== requiredName && (other === base || other.endsWith(`.${base}`)),
  );
}
