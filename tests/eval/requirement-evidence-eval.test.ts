/**
 * THE HARNESS'S OWN TESTS (plan 6.2).
 *
 * A harness that cannot fail measures nothing, so these tests do three things:
 *
 *   1. run the REAL matcher (src/campaign/campaign-planner.ts's
 *      `quotableFactsOf` + `closingFact`) over the REAL pinned dataset and
 *      assert the rates it produces;
 *   2. prove the gate FIRES — an inverted oracle must be reported as a
 *      regression, and the four exit codes are distinguished end to end
 *      through the CLI;
 *   3. hold the rule that outranks both rates: a row nothing here can settle
 *      is NOT MEASURED, is reported on its own, and is never folded into
 *      either rate or into a pass.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  ORACLE,
  decideVerdict,
  judgeRows,
  measureRates,
  parseArgs,
  renderReport,
  validateDataset,
} from "../../scripts/eval/requirement-evidence-eval.mjs";
import { EXIT, STATE } from "../../scripts/eval/learning-eval-core.mjs";
import { closingFact, quotableFactsOf } from "../../src/campaign/campaign-planner.js";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const CLI = join(REPO_ROOT, "scripts", "eval", "requirement-evidence-eval.mjs");
const DATASET_PATH = join(REPO_ROOT, "scripts", "eval", "datasets", "requirement-evidence.json");
const matcher = { quotableFactsOf, closingFact };

function loadDataset(): {
  budgets: { maxFalseClosedRate: number; maxFalseOpenRate: number; minRowsPerRate: number };
  rows: Array<{ id: string; requirement: string; evidence: Record<string, unknown>; expected: string; rationale: string; source: string }>;
} {
  return JSON.parse(readFileSync(DATASET_PATH, "utf8"));
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("the pinned dataset", () => {
  it("validates, and every row argues its own verdict", () => {
    const dataset = validateDataset(loadDataset());
    expect(dataset.rows.length).toBeGreaterThanOrEqual(40);
    for (const row of dataset.rows) {
      expect(row.rationale.length, row.id).toBeGreaterThan(20);
      expect(row.source.length, row.id).toBeGreaterThan(0);
    }
    // All three oracle verdicts are represented, or one of the buckets is
    // untested by construction.
    const verdicts = new Set(dataset.rows.map((r) => r.expected));
    expect([...verdicts].sort()).toEqual([ORACLE.NOT_MEASURED, ORACLE.NOT_PROVEN, ORACLE.PROVEN].sort());
  });

  it("pre-registers budgets, with false-closing budgeted harder than false-opening", () => {
    const { budgets } = loadDataset();
    // The asymmetry is the point: a false close ships a missing feature.
    expect(budgets.maxFalseClosedRate).toBeLessThanOrEqual(budgets.maxFalseOpenRate);
    expect(budgets.minRowsPerRate).toBeGreaterThanOrEqual(10);
  });

  it("refuses a dataset whose verdicts are unargued, mislabelled or duplicated", () => {
    const good = loadDataset();
    const oneRow = { ...good, rows: [good.rows[0]!] };
    expect(() => validateDataset({ ...oneRow, rows: [{ ...oneRow.rows[0]!, rationale: "because" }] })).toThrow(/rationale/);
    expect(() => validateDataset({ ...oneRow, rows: [{ ...oneRow.rows[0]!, expected: "maybe" }] })).toThrow(/expected/);
    expect(() => validateDataset({ ...oneRow, rows: [{ ...oneRow.rows[0]!, source: "" }] })).toThrow(/source/);
    expect(() => validateDataset({ ...oneRow, rows: [oneRow.rows[0]!, oneRow.rows[0]!] })).toThrow(/duplicate/);
    expect(() => validateDataset({ ...good, budgets: { maxFalseClosedRate: 0 } })).toThrow(/budgets/);
    expect(() => validateDataset({ ...good, rows: [] })).toThrow(/non-empty/);
  });
});

describe("the measured rates", () => {
  it("runs the real matcher over the real dataset and stays inside the pre-registered budgets", () => {
    const dataset = loadDataset();
    const judged = judgeRows(dataset.rows, matcher);
    const { measures, notMeasured, counts } = measureRates(judged, dataset.budgets);
    const falseClosed = measures.find((m) => m.name === "false-closed-rate")!;
    const falseOpen = measures.find((m) => m.name === "false-open-rate")!;

    expect(falseClosed.state, JSON.stringify(falseClosed)).toBe(STATE.GOOD);
    expect(falseOpen.state, JSON.stringify(falseOpen)).toBe(STATE.GOOD);
    // The numbers themselves, so a change to the matcher shows up here.
    expect(falseClosed.value).toBe(0);
    expect(falseOpen.wrong).toBe(3);
    expect(falseOpen.value).toBeCloseTo(3 / falseOpen.denominator, 6);
    expect(counts.errored).toBe(0);
    expect(notMeasured.harnessFailed).toEqual([]);
    expect(decideVerdict({ measures, notMeasured }).exitCode).toBe(EXIT.MEASURED_GOOD);
  });

  it("keeps the NOT MEASURED rows out of both denominators", () => {
    const dataset = loadDataset();
    const judged = judgeRows(dataset.rows, matcher);
    const { measures, notMeasured, counts } = measureRates(judged, dataset.budgets);
    const undecidable = dataset.rows.filter((r) => r.expected === ORACLE.NOT_MEASURED);
    expect(undecidable.length).toBeGreaterThan(0);
    expect(notMeasured.oracleUndecidable.sort()).toEqual(undecidable.map((r) => r.id).sort());
    expect(notMeasured.total).toBe(undecidable.length);
    // Neither denominator includes them…
    const denominators = measures.reduce((sum, m) => sum + m.denominator, 0);
    expect(denominators).toBe(counts.rows - undecidable.length);
    // …and at least one of them is a row the matcher CLOSES, so folding them
    // into the false-closed rate would have changed the number.
    const closedUndecidable = judged.filter((j) => j.expected === ORACLE.NOT_MEASURED && j.matcher === "closed");
    expect(closedUndecidable.length).toBeGreaterThan(0);
  });

  it("reports a rate as NOT MEASURED rather than passing it on too few rows", () => {
    const dataset = loadDataset();
    const judged = judgeRows(dataset.rows.slice(0, 4), matcher);
    const { measures } = measureRates(judged, { ...dataset.budgets, minRowsPerRate: 15 });
    for (const m of measures) expect(m.state).toBe(STATE.UNMEASURED);
    const verdict = decideVerdict({ measures, notMeasured: { oracleUndecidable: [], harnessFailed: [], total: 0 } });
    expect(verdict.exitCode).toBe(EXIT.NOT_MEASURED);
    expect(verdict.verdict).toBe(STATE.UNMEASURED);
    expect(renderReport({ ...dataset, dataset: DATASET_PATH, measures, counts: { rows: 4, proven: 2, notProven: 2, undecidable: 0, errored: 0 }, notMeasured: { oracleUndecidable: [], harnessFailed: [], total: 0 }, ...verdict })).toContain("NOT MEASURED");
  });

  it("a row the harness cannot judge is NOT MEASURED, never a pass", () => {
    const broken = {
      quotableFactsOf: () => {
        throw new Error("the matcher blew up");
      },
      closingFact: () => undefined,
    };
    const judged = judgeRows(loadDataset().rows, broken);
    const { measures, notMeasured, counts } = measureRates(judged, { maxFalseClosedRate: 0, maxFalseOpenRate: 0, minRowsPerRate: 1 });
    expect(counts.errored).toBe(judged.length);
    expect(notMeasured.harnessFailed.length).toBe(judged.length);
    // Both rates lost their denominators, and the verdict is not-measured —
    // not "0% false closures, all good".
    for (const m of measures) expect(m.state).toBe(STATE.UNMEASURED);
    expect(decideVerdict({ measures, notMeasured }).exitCode).toBe(EXIT.NOT_MEASURED);
  });

  it("ONE unjudgeable row keeps the whole run out of a pass, even with both rates good", () => {
    // The branch that matters most: every rate measured and inside its budget,
    // and a single row nobody could judge. A run that reported exit 0 here
    // would be claiming a clean measurement of a row it skipped.
    const dataset = loadDataset();
    const doomed = dataset.rows[0]!.id;
    let call = 0;
    const flaky = {
      // Rows are judged in order, so the first call is the first row.
      quotableFactsOf: (ms: readonly Record<string, unknown>[]) => {
        if (call++ === 0) throw new Error("this one row blew up");
        return quotableFactsOf(ms as never);
      },
      closingFact,
    };
    const judged = judgeRows(dataset.rows, flaky);
    const { measures, notMeasured } = measureRates(judged, dataset.budgets);
    for (const m of measures) expect(m.state).toBe(STATE.GOOD);
    expect(notMeasured.harnessFailed.map((f) => f.id)).toEqual([doomed]);
    const verdict = decideVerdict({ measures, notMeasured });
    expect(verdict.exitCode).toBe(EXIT.NOT_MEASURED);
    expect(verdict.reasons.join(" ")).toContain("could not judge");
  });

  it("the false-closed rate rises when a negative measurement is allowed to close a requirement", () => {
    // The defect the dataset pins: a measured line that says the thing is NOT
    // there is ABOUT the thing, so a matcher that judges topicality alone
    // closes the requirement on its own refutation.
    const dataset = loadDataset();
    const blind = {
      quotableFactsOf: (ms: readonly Record<string, unknown>[]) => {
        const facts: string[] = [];
        for (const m of ms) {
          if (typeof m["commitNote"] === "string") facts.push(`landed: ${m["commitNote"]}`);
          for (const line of (m["structureFindings"] as string[] | undefined) ?? []) facts.push(`shipped tree: ${line}`);
          for (const line of (m["gddClaims"] as string[] | undefined) ?? []) facts.push(`document numbers: ${line}`);
        }
        return facts;
      },
      closingFact,
    };
    const judged = judgeRows(dataset.rows, blind);
    const { measures } = measureRates(judged, dataset.budgets);
    const falseClosed = measures.find((m) => m.name === "false-closed-rate")!;
    expect(falseClosed.state).toBe(STATE.REGRESSED);
    expect(falseClosed.wrong).toBeGreaterThanOrEqual(6);
    expect(falseClosed.rows).toContain("bomb-by-no-trace-finding");
    expect(falseClosed.rows).toContain("fps-by-not-met-claim");
  });
});

describe("the CLI's exit contract", () => {
  it("0 when both rates are measured and inside their budgets", () => {
    const run = runCli([]);
    expect(run.stdout).toContain("false-closed-rate");
    expect(run.stdout).toContain("verdict: measured-good");
    expect(run.status).toBe(EXIT.MEASURED_GOOD);
  });

  it("1 when a rate is over its budget", () => {
    const run = runCli(["--max-false-open", "0"]);
    expect(run.status).toBe(EXIT.MEASURED_REGRESSED);
    expect(run.stdout).toContain("REGRESSED");
  });

  it("2 on a bad invocation or an unreadable dataset", () => {
    expect(runCli(["--not-an-argument"]).status).toBe(EXIT.USAGE);
    expect(runCli(["--dataset", "does/not/exist.json"]).status).toBe(EXIT.USAGE);
    const dir = mkdtempSync(join(tmpdir(), "req-eval-"));
    try {
      const bad = join(dir, "bad.json");
      writeFileSync(bad, JSON.stringify({ budgets: { maxFalseClosedRate: 0, maxFalseOpenRate: 0, minRowsPerRate: 1 }, rows: [{ id: "x", requirement: "Shop: absent", evidence: {}, expected: "proven", rationale: "too short", source: "here" }] }));
      const run = runCli(["--dataset", bad]);
      expect(run.status).toBe(EXIT.USAGE);
      expect(run.stderr).toContain("rationale");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("3 when a rate could not be measured", () => {
    const run = runCli(["--min-rows", "999"]);
    expect(run.status).toBe(EXIT.NOT_MEASURED);
    expect(run.stdout).toContain("NOT MEASURED");
    expect(run.stdout).toContain("verdict: not-measured");
  });

  it("--verify-can-fail proves the gate fires", () => {
    const run = runCli(["--verify-can-fail"]);
    expect(run.stdout).toContain("the gate fires");
    expect(run.stdout).not.toContain("THE GATE IS BROKEN");
    expect(run.status).toBe(EXIT.MEASURED_REGRESSED);
  });

  it("--json carries the rates, the budgets and the NOT MEASURED tally", () => {
    const run = runCli(["--json"]);
    expect(run.status).toBe(EXIT.MEASURED_GOOD);
    const result = JSON.parse(run.stdout);
    expect(result.harness).toContain("6.2");
    expect(result.measures.map((m: { name: string }) => m.name)).toEqual(["false-closed-rate", "false-open-rate"]);
    expect(result.notMeasured.total).toBeGreaterThan(0);
    expect(result.budgets.maxFalseClosedRate).toBe(0);
  });

  it("--help exits 0 and prints the exit contract", () => {
    const run = runCli(["--help"]);
    expect(run.status).toBe(EXIT.MEASURED_GOOD);
    expect(run.stdout).toContain("exit 0 measured and good");
  });
});

describe("parseArgs", () => {
  it("reads the overrides and refuses what it does not know", () => {
    expect(parseArgs(["--json", "--rows"])).toMatchObject({ json: true, rows: true });
    expect(parseArgs(["--max-false-closed", "0.1"]).overrides).toEqual({ maxFalseClosedRate: 0.1 });
    expect(parseArgs(["--max-false-closed", "nope"]).error).toContain("needs a number");
    expect(parseArgs(["--wat"]).error).toContain("unknown argument");
  });
});
