#!/usr/bin/env node
/**
 * Pins a deterministic subset of microsoft/SWE-Sharp-Bench.
 *
 * SWE-Sharp-Bench is SWE-bench for the C#/.NET ecosystem: 150 real bug-fix
 * tasks with the repo, the commit to start from, the tests that must go from
 * failing to passing (FAIL_TO_PASS) and the ones that must not break
 * (PASS_TO_PASS). It is the closest thing to a competitor-comparable score for
 * what Strada actually does.
 *
 * A score is only comparable against itself over time if the task set is fixed,
 * so this writes the subset to disk with a content hash. Re-fetching later and
 * getting a different hash means upstream changed the dataset — which is a
 * thing to notice deliberately, not to silently absorb into a "we improved"
 * narrative.
 *
 * Usage:
 *   node scripts/bench/swe-sharp/fetch-tasks.mjs [--count 50] [--check]
 *
 * `--check` re-fetches and compares against the pinned file without writing.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
// Decoding and subset selection live in src/bench so they can be unit-tested.
// The FAIL_TO_PASS columns are Python repr strings, not JSON, and a decoder
// that fails soft to [] makes every task vacuously resolved — that has to be
// covered by tests, not by a script nobody runs without .NET installed.
import { decodeTestList, selectSubset } from "../../../dist/bench/swe-sharp-dataset.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT_DIR = path.join(ROOT, "benchmarks", "swe-sharp");
const OUT_FILE = path.join(OUT_DIR, "tasks.json");

const DATASET = "microsoft/SWE-Sharp-Bench";
const ROWS_URL = "https://datasets-server.huggingface.co/rows";
/** The API caps a single page; the full set is 150 rows so two pages suffice. */
const PAGE_SIZE = 100;

const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};
const COUNT = Number(arg("--count", "50"));
const CHECK = argv.includes("--check");

async function fetchPage(offset, length) {
  const url =
    `${ROWS_URL}?dataset=${encodeURIComponent(DATASET)}&config=default&split=train` +
    `&offset=${offset}&length=${length}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${DATASET}: HTTP ${res.status} fetching rows at offset ${offset}`);
  const body = await res.json();
  return body.rows.map((r) => r.row);
}

async function fetchAll() {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await fetchPage(offset, PAGE_SIZE);
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

function toTask(row) {
  return {
    instanceId: row.instance_id,
    repo: row.repo,
    baseCommit: row.base_commit,
    problemStatement: row.problem_statement,
    // The reference solution. Kept for scoring context and for a control run
    // ("does the harness score the gold patch as resolved?"), never fed to the
    // agent — doing so would measure nothing.
    goldPatch: row.patch,
    testPatch: row.test_patch,
    failToPass: decodeTestList(row.FAIL_TO_PASS),
    passToPass: decodeTestList(row.PASS_TO_PASS),
  };
}

function contentHash(tasks) {
  const h = createHash("sha256");
  // Hash only the fields that define the task, so an upstream metadata edit
  // (hints, timestamps) does not read as a changed benchmark.
  for (const t of tasks) {
    h.update(t.instanceId).update(t.baseCommit).update(t.testPatch);
    h.update(t.failToPass.join(",")).update(t.passToPass.join(","));
  }
  return h.digest("hex");
}

const rows = await fetchAll();
const all = rows.map(toTask);

// A number of upstream rows ship a literally empty FAIL_TO_PASS — 15 of the
// first 100. Those tasks cannot demonstrate that anything was fixed, so they
// are excluded from the subset rather than counted as automatic failures,
// which would depress the score for a reason that has nothing to do with the
// agent. (evaluateResolution refuses to score them too, as a backstop.)
const scoreable = all.filter((t) => t.failToPass.length > 0);
const excluded = all.length - scoreable.length;

// Round-robin across repositories. Sorting by id and slicing is deterministic
// too, but the first 50 ids of this dataset come from only 3 of its
// repositories, so that subset would measure three codebases.
const tasks = selectSubset(scoreable, COUNT);
const payload = {
  dataset: DATASET,
  count: tasks.length,
  excludedUnscoreable: excluded,
  contentHash: contentHash(tasks),
  tasks,
};

const repoCount = new Set(tasks.map((t) => t.repo)).size;
console.log(
  `${DATASET}: ${rows.length} rows upstream, ${excluded} unscoreable (no FAIL_TO_PASS), ` +
    `pinned ${tasks.length} across ${repoCount} repos`,
);
// A pinned task with no required tests would be vacuously resolvable, which is
// also what a broken decoder produces — so this stays a hard error.
if (tasks.some((t) => t.failToPass.length === 0)) {
  console.error("\nA pinned task has no FAIL_TO_PASS tests — selection or decoding is wrong.");
  process.exit(2);
}
console.log(`content hash: ${payload.contentHash}`);

if (CHECK) {
  if (!existsSync(OUT_FILE)) {
    console.error(`No pinned task set at ${path.relative(ROOT, OUT_FILE)} — run without --check first.`);
    process.exit(2);
  }
  const pinned = JSON.parse(readFileSync(OUT_FILE, "utf8"));
  if (pinned.contentHash !== payload.contentHash) {
    console.error(
      `\nUpstream dataset changed.\n  pinned:  ${pinned.contentHash}\n  fetched: ${payload.contentHash}\n` +
        `Scores before and after this point are not comparable. Re-pin deliberately.`,
    );
    process.exit(1);
  }
  console.log("\nPinned task set matches upstream.");
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log(`\nWrote ${path.relative(ROOT, OUT_FILE)}`);
