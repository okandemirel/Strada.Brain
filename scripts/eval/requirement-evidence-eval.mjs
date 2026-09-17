#!/usr/bin/env node
/**
 * requirement-evidence-eval.mjs — how often does the requirement–evidence map
 * get it WRONG? (plan item 6.2)
 *
 * The matcher under test is PRODUCTION CODE, not a copy of it:
 * `quotableFactsOf` builds the record a coverage verdict may quote, and
 * `closingFact` applies the typed, requirement-specific predicate of plan
 * 0-B.3 (src/campaign/campaign-planner.ts). Each row of the pinned dataset is
 * one requirement against one milestone's measured evidence, with an oracle
 * verdict registered in the dataset before any of this ran.
 *
 * Two rates, and one rule that outranks both:
 *
 *   FALSE-CLOSED — of the requirements the oracle says are NOT proven, how many
 *                  does the matcher close? This is the dangerous direction: a
 *                  closed requirement is a feature nobody looks for again.
 *   FALSE-OPEN   — of the requirements the oracle says ARE proven, how many does
 *                  the matcher leave open? This costs a repair round.
 *
 *   NOT MEASURED IS NOT A RATE. A row whose oracle verdict is `not_measured`
 *   (nothing in that evidence can settle the requirement either way) and a row
 *   this harness could not run are reported on their own and are NEVER folded
 *   into either rate or into a pass.
 *
 * Exit codes (the contract scripts/eval/learning-eval.mjs uses):
 *   0  measured and good        — both rates ran and stayed inside their budgets
 *   1  measured and regressed   — a rate ran and came out worse than its budget
 *   2  bad invocation / unreadable dataset / the harness itself failed
 *   3  NOT MEASURED             — a rate could not be measured (too few rows, or
 *                                the matcher could not be loaded)
 *
 * Usage:
 *   node scripts/eval/requirement-evidence-eval.mjs
 *   node scripts/eval/requirement-evidence-eval.mjs --dataset <path>
 *   node scripts/eval/requirement-evidence-eval.mjs --json
 *   node scripts/eval/requirement-evidence-eval.mjs --rows        # every row's verdict
 *   node scripts/eval/requirement-evidence-eval.mjs --verify-can-fail
 *
 * HONESTY CONTRACT
 *   - The matcher is real. The ORACLE is human judgement, pre-registered in the
 *     dataset with a `rationale` per row, so every number here can be argued
 *     with instead of taken on trust.
 *   - The rows are real SHAPES from this repo — requirement wordings and
 *     measured lines from its tests, its structure findings and its
 *     document-number lines — not invented prose. `source` names where each
 *     came from.
 *   - The budgets are pre-registered FOR THIS ROW SET. They are a regression
 *     gate, not a claim that the matcher is right in general.
 *   - No LLM runs here. This measures the deterministic predicate; whether a
 *     model picks the right line to quote is a different measurement and is NOT
 *     made by this harness.
 */

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { EXIT, STATE } from "./learning-eval-core.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..");
const DEFAULT_DATASET_PATH = resolve(__dirname, "datasets", "requirement-evidence.json");
const TSX_GUARD = "STRADA_REQUIREMENT_EVAL_TSX";

/** The oracle's three verdicts. `not_measured` is never folded into a rate. */
export const ORACLE = Object.freeze({ PROVEN: "proven", NOT_PROVEN: "not_proven", NOT_MEASURED: "not_measured" });

const HELP = `requirement-evidence-eval.mjs — requirement–evidence map (plan 6.2)

  --dataset <path>            pinned dataset (default scripts/eval/datasets/requirement-evidence.json)
  --rows                      print every row's oracle verdict against the matcher's
  --json                      machine-readable result on stdout
  --max-false-closed N        override the dataset's budget
  --max-false-open N          override the dataset's budget
  --verify-can-fail           invert every oracle verdict, so a working harness MUST
                              report a regression (expects exit 1)

exit 0 measured and good · 1 measured and regressed · 2 bad invocation · 3 NOT measured`;

export function parseArgs(argv) {
  const args = { dataset: null, json: false, rows: false, help: false, verifyCanFail: false, overrides: {} };
  const numeric = { "--max-false-closed": "maxFalseClosedRate", "--max-false-open": "maxFalseOpenRate", "--min-rows": "minRowsPerRate" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dataset") args.dataset = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--rows") args.rows = true;
    else if (a === "--verify-can-fail") args.verifyCanFail = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else if (numeric[a] !== undefined) {
      const raw = Number(argv[++i]);
      if (!Number.isFinite(raw)) return { error: `${a} needs a number` };
      args.overrides[numeric[a]] = raw;
    } else return { error: `unknown argument: ${a}` };
  }
  return args;
}

/**
 * A dataset that cannot be trusted is a bad invocation, not a pass. Every row
 * must carry the oracle verdict AND the reason for it: an unargued verdict is
 * the thing this harness exists to avoid.
 */
export function validateDataset(raw) {
  if (raw === null || typeof raw !== "object") throw new Error("dataset must be an object");
  const budgets = raw.budgets;
  if (budgets === null || typeof budgets !== "object") throw new Error("dataset.budgets is required");
  for (const key of ["maxFalseClosedRate", "maxFalseOpenRate", "minRowsPerRate"]) {
    if (!Number.isFinite(budgets[key])) throw new Error(`dataset.budgets.${key} must be a number`);
  }
  if (!Array.isArray(raw.rows) || raw.rows.length === 0) throw new Error("dataset.rows must be a non-empty array");
  const ids = new Set();
  const verdicts = new Set(Object.values(ORACLE));
  for (const row of raw.rows) {
    if (typeof row?.id !== "string" || row.id === "") throw new Error("every row needs an id");
    if (ids.has(row.id)) throw new Error(`duplicate row id: ${row.id}`);
    ids.add(row.id);
    if (typeof row.requirement !== "string" || row.requirement.trim() === "") {
      throw new Error(`row ${row.id}: requirement must be a non-empty string`);
    }
    if (row.evidence === null || typeof row.evidence !== "object" || Array.isArray(row.evidence)) {
      throw new Error(`row ${row.id}: evidence must be a milestone-shaped object`);
    }
    if (!verdicts.has(row.expected)) {
      throw new Error(`row ${row.id}: expected must be one of ${[...verdicts].join(", ")}`);
    }
    if (typeof row.rationale !== "string" || row.rationale.trim().length < 20) {
      throw new Error(`row ${row.id}: rationale must say WHY the oracle says that`);
    }
    if (typeof row.source !== "string" || row.source.trim() === "") {
      throw new Error(`row ${row.id}: source must name where the shape came from`);
    }
  }
  return raw;
}

/** Run every row through the production predicate. */
export function judgeRows(rows, matcher) {
  return rows.map((row) => {
    let facts;
    let closedBy;
    let error;
    try {
      facts = matcher.quotableFactsOf([row.evidence]);
      closedBy = matcher.closingFact(row.requirement, facts);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    return {
      id: row.id,
      requirement: row.requirement,
      expected: row.expected,
      rationale: row.rationale,
      source: row.source,
      quotableFacts: facts ?? [],
      matcher: error !== undefined ? "error" : closedBy !== undefined ? "closed" : "open",
      ...(closedBy === undefined ? {} : { closedBy }),
      ...(error === undefined ? {} : { error }),
    };
  });
}

/**
 * The two rates, and the NOT MEASURED tally that is kept out of both.
 *
 * A rate whose denominator is under the pre-registered minimum is reported
 * unmeasured rather than as a flattering fraction of three rows.
 */
export function measureRates(judged, budgets) {
  const errored = judged.filter((j) => j.matcher === "error");
  const undecidable = judged.filter((j) => j.expected === ORACLE.NOT_MEASURED && j.matcher !== "error");
  const notProven = judged.filter((j) => j.expected === ORACLE.NOT_PROVEN && j.matcher !== "error");
  const proven = judged.filter((j) => j.expected === ORACLE.PROVEN && j.matcher !== "error");
  const falseClosed = notProven.filter((j) => j.matcher === "closed");
  const falseOpen = proven.filter((j) => j.matcher === "open");

  const rate = (name, wrong, denominator, budget, what) => {
    if (denominator.length < budgets.minRowsPerRate) {
      return {
        name,
        state: STATE.UNMEASURED,
        reason:
          `${denominator.length} row(s) with this oracle verdict, fewer than the pre-registered minimum of ` +
          `${budgets.minRowsPerRate} — a rate over that many rows says nothing`,
        wrong: wrong.length,
        denominator: denominator.length,
        budget,
      };
    }
    const value = wrong.length / denominator.length;
    return {
      name,
      state: value <= budget ? STATE.GOOD : STATE.REGRESSED,
      value,
      wrong: wrong.length,
      denominator: denominator.length,
      budget,
      what,
      rows: wrong.map((j) => j.id),
    };
  };

  return {
    measures: [
      rate(
        "false-closed-rate",
        falseClosed,
        notProven,
        budgets.maxFalseClosedRate,
        "requirements the matcher CLOSES that the oracle says are not proven",
      ),
      rate(
        "false-open-rate",
        falseOpen,
        proven,
        budgets.maxFalseOpenRate,
        "requirements the oracle says ARE proven that the matcher leaves open",
      ),
    ],
    notMeasured: {
      /** Rows whose oracle verdict is "nothing here settles it" — by construction outside both rates. */
      oracleUndecidable: undecidable.map((j) => j.id),
      /** Rows the harness itself could not judge. Never a pass, never a rate. */
      harnessFailed: errored.map((j) => ({ id: j.id, error: j.error })),
      total: undecidable.length + errored.length,
    },
    counts: {
      rows: judged.length,
      proven: proven.length,
      notProven: notProven.length,
      undecidable: undecidable.length,
      errored: errored.length,
    },
  };
}

export function decideVerdict({ measures, notMeasured }) {
  const reasons = [];
  let regressed = false;
  let missing = false;
  for (const m of measures) {
    if (m.state === STATE.REGRESSED) {
      regressed = true;
      reasons.push(`${m.name}: ${(m.value * 100).toFixed(1)}% (${m.wrong}/${m.denominator}) over its budget of ${(m.budget * 100).toFixed(1)}%`);
    } else if (m.state === STATE.UNMEASURED) {
      missing = true;
      reasons.push(`${m.name}: NOT MEASURED — ${m.reason}`);
    }
  }
  if (notMeasured.harnessFailed.length > 0) {
    missing = true;
    reasons.push(`${notMeasured.harnessFailed.length} row(s) the harness could not judge at all`);
  }
  if (regressed) return { verdict: STATE.REGRESSED, exitCode: EXIT.MEASURED_REGRESSED, reasons };
  if (missing) return { verdict: STATE.UNMEASURED, exitCode: EXIT.NOT_MEASURED, reasons };
  return { verdict: STATE.GOOD, exitCode: EXIT.MEASURED_GOOD, reasons };
}

export function renderReport(result) {
  const out = [];
  out.push("requirement–evidence map — plan 6.2");
  out.push(`dataset: ${result.dataset}`);
  out.push(
    `rows: ${result.counts.rows} (${result.counts.notProven} not proven, ${result.counts.proven} proven, ` +
      `${result.counts.undecidable} NOT MEASURABLE by any predicate here)`,
  );
  out.push("");
  for (const m of result.measures) {
    if (m.state === STATE.UNMEASURED) {
      out.push(`NOT MEASURED  ${m.name} — ${m.reason}`);
      continue;
    }
    const tag = m.state === STATE.GOOD ? "OK       " : "REGRESSED";
    out.push(`${tag}  ${m.name}: ${(m.value * 100).toFixed(1)}%  (${m.wrong}/${m.denominator}, budget ${(m.budget * 100).toFixed(1)}%)`);
    out.push(`            ${m.what}`);
    if (m.rows.length > 0) out.push(`            rows: ${m.rows.join(", ")}`);
  }
  out.push("");
  out.push(
    `NOT MEASURED (folded into neither rate): ${result.notMeasured.total} — ` +
      `${result.notMeasured.oracleUndecidable.length} row(s) no predicate here can settle` +
      (result.notMeasured.oracleUndecidable.length > 0 ? ` (${result.notMeasured.oracleUndecidable.join(", ")})` : "") +
      `, ${result.notMeasured.harnessFailed.length} row(s) the harness could not judge`,
  );
  for (const f of result.notMeasured.harnessFailed) out.push(`   ${f.id}: ${f.error}`);
  if (result.rows) {
    out.push("");
    out.push("per row (oracle → matcher):");
    for (const r of result.rows) {
      const agree = r.expected === ORACLE.NOT_MEASURED ? "·" : (r.expected === ORACLE.PROVEN) === (r.matcher === "closed") ? " " : "✗";
      out.push(` ${agree} ${r.id}: ${r.expected} → ${r.matcher}${r.closedBy ? ` [${r.closedBy.slice(0, 80)}]` : ""}`);
    }
  }
  out.push("");
  out.push(`verdict: ${result.verdict}`);
  for (const reason of result.reasons) out.push(`   ${reason}`);
  out.push("");
  out.push(
    "the matcher is production code (quotableFactsOf + closingFact, src/campaign/campaign-planner.ts); " +
      "the oracle is pre-registered human judgement with a rationale per row; no LLM runs here, so " +
      "whether a model picks the right line to quote is NOT measured by this harness",
  );
  out.push(
    `exit contract: ${EXIT.MEASURED_GOOD}=measured and good  ${EXIT.MEASURED_REGRESSED}=measured and regressed  ` +
      `${EXIT.NOT_MEASURED}=not measured  ${EXIT.USAGE}=bad invocation`,
  );
  return out.join("\n");
}

/**
 * Plain node cannot resolve src/'s .js specifiers onto .ts files, so the
 * harness re-execs itself once under tsx and forwards the child's exit code —
 * `node scripts/eval/requirement-evidence-eval.mjs` keeps working either way.
 */
function reExecUnderTsx(argv) {
  const result = spawnSync(process.execPath, ["--import", "tsx", __filename, ...argv], {
    stdio: "inherit",
    cwd: repoRoot,
    env: { ...process.env, [TSX_GUARD]: "1" },
  });
  if (result.error) {
    console.error(`failed to re-exec under tsx: ${result.error.message}`);
    return EXIT.USAGE;
  }
  return result.status ?? EXIT.USAGE;
}

async function loadMatcher() {
  const planner = await import(new URL("../../src/campaign/campaign-planner.ts", import.meta.url).href);
  if (typeof planner.quotableFactsOf !== "function" || typeof planner.closingFact !== "function") {
    throw new Error("campaign-planner.ts does not export quotableFactsOf/closingFact");
  }
  return { quotableFactsOf: planner.quotableFactsOf, closingFact: planner.closingFact };
}

export async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.error) {
    console.error(args.error);
    console.error(HELP);
    return EXIT.USAGE;
  }
  if (args.help) {
    console.log(HELP);
    return EXIT.MEASURED_GOOD;
  }

  let matcher;
  try {
    matcher = await loadMatcher();
  } catch (err) {
    if (!process.env[TSX_GUARD]) return reExecUnderTsx(argv);
    // The matcher could not be loaded: NOT MEASURED, never a pass.
    console.error(
      `NOT MEASURED: the requirement–evidence matcher could not be loaded — ${err instanceof Error ? err.message : String(err)}`,
    );
    return EXIT.NOT_MEASURED;
  }

  const datasetPath = args.dataset ? resolve(repoRoot, args.dataset) : DEFAULT_DATASET_PATH;
  let dataset;
  try {
    dataset = validateDataset(JSON.parse(await readFile(datasetPath, "utf8")));
  } catch (err) {
    console.error(`dataset ${datasetPath}: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.USAGE;
  }

  const budgets = { ...dataset.budgets, ...args.overrides };
  // The gate check: with every oracle verdict flipped, a working harness MUST
  // report a regression. A harness that cannot fail measures nothing.
  const rows = args.verifyCanFail
    ? dataset.rows.map((r) => ({
        ...r,
        expected:
          r.expected === ORACLE.PROVEN ? ORACLE.NOT_PROVEN : r.expected === ORACLE.NOT_PROVEN ? ORACLE.PROVEN : r.expected,
      }))
    : dataset.rows;

  const judged = judgeRows(rows, matcher);
  const { measures, notMeasured, counts } = measureRates(judged, budgets);
  const verdict = decideVerdict({ measures, notMeasured });
  const result = {
    harness: "requirement-evidence-eval 6.2",
    dataset: datasetPath,
    budgets,
    measures,
    notMeasured,
    counts,
    ...(args.rows ? { rows: judged } : {}),
    ...verdict,
  };

  if (args.verifyCanFail) {
    const ok = verdict.exitCode === EXIT.MEASURED_REGRESSED;
    console.log(renderReport({ ...result, rows: judged }));
    console.log(
      `\n--verify-can-fail: every oracle verdict was inverted, so the harness must report a regression. ` +
        `It reported ${verdict.verdict} (exit ${verdict.exitCode}) — ${ok ? "the gate fires" : "THE GATE IS BROKEN"}.`,
    );
    return ok ? EXIT.MEASURED_REGRESSED : EXIT.USAGE;
  }

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderReport(result));
  return verdict.exitCode;
}

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err?.stack ?? String(err));
      process.exit(EXIT.USAGE);
    });
}
