#!/usr/bin/env node
/**
 * Benchmark baseline recorder and regression gate.
 *
 * `vitest bench --compare` prints a comparison but cannot fail a build, so the
 * gate lives here. Absolute timings are machine-specific, which is why the
 * baseline is keyed by `<platform>-node<major>` and committed alongside the
 * code that produced it: a refactor moves its own baseline in the same PR.
 *
 * Usage:
 *   node scripts/bench/gate.mjs --record          # write/refresh the baseline
 *   node scripts/bench/gate.mjs --check           # compare, exit 1 on regression
 *   node scripts/bench/gate.mjs --check --threshold 0.25
 *   node scripts/bench/gate.mjs --check --require-baseline
 *   node scripts/bench/gate.mjs --check --fail-on-missing-metric
 *
 * Two ways this gate could report success without measuring anything, both
 * closed by a flag because a gate that is silent about its own absence is worse
 * than no gate (audited 2026-09-17):
 *
 *   --require-baseline        No baseline for this runner is a hard failure, not
 *                            a skip. CI runs ubuntu/node22 and only
 *                            darwin-node26 was ever committed, so the timing
 *                            gate has been a no-op there since it was written.
 *   --fail-on-missing-metric A metric the baseline has and the run does not is a
 *                            hard failure. A renamed or deleted benchmark
 *                            otherwise just prints a "?" line and stops being
 *                            gated, quietly and forever.
 *
 * Reads the report written by `vitest bench --outputJson`.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT = path.join(ROOT, "benchmarks", ".report.json");
const BASELINE_DIR = path.join(ROOT, "benchmarks", "baselines");

/**
 * Default regression threshold. Deliberately loose: a per-PR gate that trips on
 * normal CI-runner noise gets muted within a week, and a muted gate protects
 * nothing. 25% catches the regressions worth catching (an accidental N+1, a
 * dropped index, a sync read on a hot path) without firing on jitter.
 */
const DEFAULT_THRESHOLD = 0.25;

/** Metrics whose rme is above this are reported but never gate — too noisy to
 *  draw a conclusion from. */
const MAX_TRUSTED_RME = 10;

function baselineKey() {
  return `${process.platform}-node${process.versions.node.split(".")[0]}`;
}

function loadReport() {
  if (!existsSync(REPORT)) {
    console.error(`[bench-gate] no report at ${path.relative(ROOT, REPORT)} — run \`npm run bench\` first`);
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(REPORT, "utf8"));
  /** @type {Record<string,{hz:number,mean:number,rme:number,samples:number}>} */
  const flat = {};
  for (const file of raw.files ?? []) {
    for (const group of file.groups ?? []) {
      for (const b of group.benchmarks ?? []) {
        flat[`${group.fullName} > ${b.name}`] = {
          hz: b.hz, mean: b.mean, rme: b.rme, samples: b.sampleCount ?? b.samples?.length ?? 0,
        };
      }
    }
  }
  return flat;
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const key = baselineKey();
const baselinePath = path.join(BASELINE_DIR, `${key}.json`);
const current = loadReport();

if (flag("--record")) {
  mkdirSync(BASELINE_DIR, { recursive: true });
  const payload = {
    key,
    node: process.versions.node,
    platform: process.platform,
    // No timestamp: it would churn the file on every re-record and make the
    // diff unreadable. Git already records when it changed.
    metrics: Object.fromEntries(
      Object.entries(current).map(([k, v]) => [k, { mean: Number(v.mean.toFixed(6)), rme: Number(v.rme.toFixed(2)) }]),
    ),
  };
  writeFileSync(baselinePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`[bench-gate] recorded ${Object.keys(current).length} metric(s) → ${path.relative(ROOT, baselinePath)}`);
  process.exit(0);
}

if (!flag("--check")) {
  console.error("[bench-gate] pass --record or --check");
  process.exit(2);
}

if (!existsSync(baselinePath)) {
  // A missing baseline for THIS runner means nobody has recorded one here yet.
  // Whether that is acceptable is the CALLER's decision: on a developer's new
  // machine it is, in CI it is not — there the skip means the job has been
  // reporting success without comparing anything.
  if (flag("--require-baseline")) {
    console.error(
      `[bench-gate] NO BASELINE for "${key}" and --require-baseline was passed: nothing was compared.\n` +
      `[bench-gate] Timings are machine-specific, so a baseline can only be recorded ON this runner:\n` +
      `[bench-gate]   npm run bench:record   (then commit benchmarks/baselines/${key}.json)`,
    );
    process.exit(2);
  }
  console.warn(`[bench-gate] no baseline for "${key}" — skipping gate. Record one with: npm run bench:record`);
  console.warn(`[bench-gate] NOTHING WAS MEASURED. Pass --require-baseline to make this a failure.`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const threshold = Number(value("--threshold", DEFAULT_THRESHOLD));
const regressions = [];
const noisy = [];
const missing = [];

for (const [name, base] of Object.entries(baseline.metrics)) {
  const now = current[name];
  if (!now) { missing.push(name); continue; }
  const ratio = now.mean / base.mean - 1;
  if (now.rme > MAX_TRUSTED_RME) {
    noisy.push({ name, rme: now.rme, ratio });
    continue;
  }
  if (ratio > threshold) regressions.push({ name, base: base.mean, now: now.mean, ratio });
}

const pct = (r) => `${(r * 100).toFixed(1)}%`;
console.log(`[bench-gate] baseline ${key}: ${Object.keys(baseline.metrics).length} metric(s), threshold ${pct(threshold)}`);
for (const n of noisy) {
  console.log(`  ~ ${n.name}: rme ${n.rme.toFixed(1)}% > ${MAX_TRUSTED_RME}% — too noisy to gate (drift ${pct(n.ratio)})`);
}
for (const m of missing) {
  console.log(`  ? ${m}: in baseline but not in this run (renamed or removed?)`);
}
// A metric that stopped being reported stopped being gated. That is a hole in
// the gate, not a detail of the run, so CI can demand it be closed.
if (missing.length > 0 && flag("--fail-on-missing-metric")) {
  console.error(
    `[bench-gate] ${missing.length} baseline metric(s) MISSING from this run — nothing gated them:\n` +
    missing.map((m) => `  ✗ ${m}`).join("\n") +
    `\n[bench-gate] Re-record the baseline if the benchmark was deliberately renamed or removed.`,
  );
  process.exit(1);
}
if (regressions.length === 0) {
  console.log("[bench-gate] no regression beyond threshold");
  process.exit(0);
}
console.error(`[bench-gate] ${regressions.length} REGRESSION(S):`);
for (const r of regressions) {
  console.error(`  ✗ ${r.name}: ${r.base.toFixed(4)}ms → ${r.now.toFixed(4)}ms (+${pct(r.ratio)})`);
}
process.exit(1);
