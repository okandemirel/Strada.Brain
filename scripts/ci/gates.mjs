#!/usr/bin/env node
/**
 * The gates every agent runs before it pushes. docs/skills/ship/SKILL.md.
 *
 * This repository is developed by agents only: no person runs a command
 * before a push, so the checks that matter must be one command an agent can
 * run, and CI repeats them. Every gate runs, even after one fails. The summary
 * comes at the end, with one exit code: 0 only when every gate passed.
 *
 *   node scripts/ci/gates.mjs              # against origin/main
 *   node scripts/ci/gates.mjs --base <ref>
 *
 * It is not the full suite. CI runs that, all 17,000+ tests, in about ten
 * minutes. These are the gates that catch what agents in this repo break most
 * often, fast enough to run before every push: types, lint on what changed,
 * the contracts' detectors, the tests vitest relates to the changed files,
 * and the commit layer of the test-integrity contract.
 */

import { spawnSync } from "node:child_process";

const argBase = process.argv.indexOf("--base");
const base = argBase === -1 ? "origin/main" : process.argv[argBase + 1];

function git(args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

const changed = git(["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`])
  .split("\n")
  .concat(git(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]).split("\n"))
  .filter(Boolean);
const changedSrc = [...new Set(changed)].filter((f) => /^src\/.*\.ts$/.test(f));

/** The contracts' detectors: docs/contracts/README.md lists what each one holds. */
const DETECTORS = [
  "src/contracts.test.ts",
  "src/test-integrity.test.ts",
  "src/file-size-ratchet.test.ts",
  "src/path-containment-ratchet.test.ts",
  "src/no-require-in-esm.test.ts",
  "src/universality.test.ts",
  "src/goals/gate-askers.test.ts",
  "src/team-memory.test.ts",
  "src/governance.test.ts",
  // Scans every script and src file, so `vitest related` never selects it.
  "src/tests/integration/entry-guard-symlink.test.ts",
];

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const gates = [
  { name: "typecheck", why: "the whole src tree compiles", cmd: [npm, "run", "typecheck:src"] },
  changedSrc.length > 0
    ? { name: "lint (changed)", why: `${changedSrc.length} changed src file(s)`, cmd: [npx, "eslint", ...changedSrc] }
    : { name: "lint (changed)", why: "no src file changed", skip: true },
  { name: "contract detectors", why: "every docs/contracts rule", cmd: [npx, "vitest", "run", ...DETECTORS] },
  changedSrc.length > 0
    ? {
        name: "related tests",
        why: "tests that import what changed",
        cmd: [npx, "vitest", "related", "--run", "--passWithNoTests", ...changedSrc],
      }
    : { name: "related tests", why: "no src file changed", skip: true },
  {
    name: "test integrity",
    why: "no commit since the base weakens a test unsaid",
    cmd: [process.execPath, "scripts/ci/check-test-integrity.mjs", "--base", base, "--head", "HEAD"],
  },
];

const results = [];
for (const gate of gates) {
  if (gate.skip) {
    results.push({ ...gate, status: "skip", seconds: 0 });
    continue;
  }
  console.log(`\n=== ${gate.name}: ${gate.why}`);
  const started = Date.now();
  const r = spawnSync(gate.cmd[0], gate.cmd.slice(1), { stdio: "inherit", shell: process.platform === "win32" });
  results.push({ ...gate, status: r.status === 0 ? "pass" : "FAIL", seconds: Math.round((Date.now() - started) / 1000) });
}

console.log("\n=== gates summary");
for (const r of results) console.log(`  ${r.status.padEnd(4)}  ${r.name.padEnd(20)} ${String(r.seconds).padStart(4)}s  ${r.why}`);
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(failed === 0 ? "  all gates passed" : `  ${failed} gate(s) failed — fix them before you push; do not bend a test to pass one`);
process.exitCode = failed === 0 ? 0 : 1;
