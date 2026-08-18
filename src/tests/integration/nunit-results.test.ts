import { describe, it, expect } from "vitest";
import { parseTestRun } from "./nunit-results.js";

/** The shape Unity's test runner writes, trimmed to what is read. */
const run = (attrs: string, cases = ""): string =>
  `<?xml version="1.0" encoding="utf-8"?>\n<test-run id="2" ${attrs}>${cases}</test-run>`;

describe("reading a Unity test run's verdict", () => {
  it("reads the counts off the top-level element", () => {
    const outcome = parseTestRun(run('testcasecount="12" result="Passed" total="12" passed="12" failed="0"'));

    expect(outcome).toEqual({ result: "Passed", total: 12, passed: 12, failed: 0 });
  });

  it("calls a mostly-failing run failed", () => {
    // The case the old assertion got wrong. `results.toContain("Passed")` is
    // true here twice over: the run-level attribute list contains passed="1",
    // and the one case that did pass carries result="Passed".
    const xml = run(
      'result="Failed" total="3" passed="1" failed="2"',
      '<test-case name="A" result="Passed"/><test-case name="B" result="Failed"/>',
    );

    expect(xml).toContain("Passed");

    const outcome = parseTestRun(xml);
    expect(outcome!.failed).toBe(2);
    expect(outcome!.result).toBe("Failed");
  });

  it("does not read a count off a test case", () => {
    // Only the run element is authoritative; a case element must not supply
    // attributes when the run element lacks them.
    const outcome = parseTestRun(run('result="Failed" total="0"', '<test-case passed="99"/>'));

    expect(outcome!.passed).toBe(0);
  });

  it("reports nothing for a results file that was never written", () => {
    expect(parseTestRun("")).toBeNull();
  });

  it("reports nothing when the run died before writing the element", () => {
    expect(parseTestRun("<?xml version=\"1.0\"?>\n")).toBeNull();
  });

  it("treats an unparseable count as zero rather than NaN", () => {
    // NaN compares false against every assertion, so it would read as a pass
    // under `failed === 0`... and as a failure under `total > 0`. Pin it.
    const outcome = parseTestRun(run('result="Passed" total="oops" failed="oops"'));

    expect(outcome!.total).toBe(0);
    expect(outcome!.failed).toBe(0);
  });
});
