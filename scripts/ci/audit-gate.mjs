#!/usr/bin/env node
/**
 * The dependency-audit gate: `npm audit` at --audit-level=high, except for
 * advisories a dated exception covers at the exact install paths it names.
 *
 * Why not `npm audit --audit-level=high` alone: on 2026-10-21 an advisory
 * against every zod 3 release (GHSA-mrhx-c7xc-m3w5) landed on the zod copies
 * the Teams SDK (botbuilder) bundles. No botbuilder release depends on a fixed
 * zod, and npm's only offered fix is a semver-major downgrade, so the gate was
 * red on every commit for two weeks and stopped saying anything about the
 * advisories that COULD be fixed. An exception keeps the gate meaningful:
 *
 * - it names one advisory and the install paths it may cover, nothing wider —
 *   the same advisory anywhere else (our own top-level zod) still fails;
 * - it carries a reason and an expiry date; an expired exception fails the
 *   gate, so somebody looks again;
 * - an exception the audit no longer needs is reported, so it can be deleted.
 *
 * Exceptions live in scripts/ci/audit-exceptions.json, keyed by the project
 * directory relative to the repository root ("." or "web-portal").
 */

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

/** "https://github.com/advisories/GHSA-xxxx-xxxx-xxxx" → "GHSA-xxxx-xxxx-xxxx"; otherwise the source number. */
export function advisoryId(via) {
  const m = /\/(GHSA-[\w-]+)\s*$/.exec(String(via.url ?? ""));
  return m ? m[1] : String(via.source ?? via.title ?? "unknown");
}

/**
 * @param {unknown} exceptions
 * @returns {string[]} what is wrong with the exceptions file, if anything
 */
export function validateExceptions(exceptions) {
  if (!Array.isArray(exceptions)) return ["the exceptions file must hold an array"];
  const problems = [];
  exceptions.forEach((e, i) => {
    const at = `exception #${i + 1}`;
    if (typeof e?.project !== "string" || e.project === "") problems.push(`${at}: project missing`);
    if (typeof e?.advisory !== "string" || !/^GHSA-/.test(e.advisory)) problems.push(`${at}: advisory must be a GHSA id`);
    if (!Array.isArray(e?.nodes) || e.nodes.length === 0) problems.push(`${at}: nodes must name the install paths it covers`);
    if (typeof e?.reason !== "string" || e.reason.length < 40) problems.push(`${at}: reason must say why, in a sentence or more`);
    if (typeof e?.expires !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) problems.push(`${at}: expires must be YYYY-MM-DD`);
  });
  return problems;
}

/**
 * Judge one project's `npm audit --json` report.
 *
 * @param {{ report: { vulnerabilities?: Record<string, { nodes?: string[]; via?: unknown[] }> };
 *           exceptions: Array<{ project: string; advisory: string; nodes: string[]; reason: string; expires: string }>;
 *           project: string; today: string; level?: keyof typeof RANK }} input
 */
export function judgeAudit({ report, exceptions, project, today, level = "high" }) {
  const mine = exceptions.filter((e) => e.project === project);
  const blocking = [];
  const exempted = [];
  const used = new Set();
  for (const [name, entry] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      // A string `via` is a dependency path to another entry, judged on its own.
      if (typeof via !== "object" || via === null) continue;
      if ((RANK[via.severity] ?? 0) < RANK[level]) continue;
      const id = advisoryId(via);
      for (const node of entry.nodes ?? []) {
        const cover = mine.find((e) => e.advisory === id && e.nodes.includes(node));
        if (!cover) {
          blocking.push(`${via.severity} ${id} (${name}) at ${node}: ${via.title ?? ""}`.trim());
        } else if (cover.expires < today) {
          blocking.push(`${via.severity} ${id} (${name}) at ${node}: its exception expired on ${cover.expires}`);
        } else {
          used.add(cover);
          exempted.push(`${id} (${name}) at ${node} — excepted until ${cover.expires}`);
        }
      }
    }
  }
  const stale = mine.filter((e) => !used.has(e)).map((e) => `${e.advisory} (${e.nodes.join(", ")})`);
  return { ok: blocking.length === 0, blocking, exempted: [...new Set(exempted)], stale };
}

/* c8 ignore start — CLI wiring; the decision is unit-tested */
function isDirectExecution() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const project = path.relative(repoRoot, process.cwd()).split(path.sep).join("/") || ".";
  const exceptions = JSON.parse(readFileSync(path.join(repoRoot, "scripts", "ci", "audit-exceptions.json"), "utf8"));
  const problems = validateExceptions(exceptions);
  if (problems.length > 0) {
    console.error(`audit-gate: scripts/ci/audit-exceptions.json is malformed:\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }
  let raw;
  try {
    // npm exits non-zero whenever it finds anything; the report is still on stdout.
    raw = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["audit", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    raw = error.stdout;
    if (!raw) {
      console.error(`audit-gate: npm audit produced no report: ${error.message}`);
      process.exit(1);
    }
  }
  const verdict = judgeAudit({
    report: JSON.parse(raw),
    exceptions,
    project,
    today: new Date().toISOString().slice(0, 10),
  });
  for (const line of verdict.exempted) console.log(`audit-gate: excepted ${line}`);
  for (const line of verdict.stale) console.log(`audit-gate: exception no longer needed, delete it: ${line}`);
  if (!verdict.ok) {
    console.error(`audit-gate (${project}): ${verdict.blocking.length} advisory finding(s) at or above high:\n  - ${verdict.blocking.join("\n  - ")}`);
    process.exitCode = 1;
  } else {
    console.log(`audit-gate (${project}): no unexcepted advisory at or above high.`);
  }
}
/* c8 ignore stop */
