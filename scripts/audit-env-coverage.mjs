#!/usr/bin/env node
/**
 * audit-env-coverage.mjs
 *
 * Advisory script that cross-checks the env vars declared in the
 * EnvVarName union (src/config/config-types.ts) against what is
 * documented in .env.example. Prints two gap lists and exits 0.
 *
 * Method: the EnvVarName union in config-types.ts uses clean
 *   | "VAR_NAME"
 * lines that are simple to extract with a regex. If the format ever
 * changes, fall back to grepping `env["VAR"]` usages.
 *
 * Usage:  node scripts/audit-env-coverage.mjs
 * npm:    npm run audit:env
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");

// ---------------------------------------------------------------------------
// 1. Extract EnvVarName members from config-types.ts
// ---------------------------------------------------------------------------
const configTypesPath = resolve(root, "src/config/config-types.ts");
const configTypesSource = readFileSync(configTypesPath, "utf8");

// Match lines of the form:   | "SOME_VAR_NAME"
// inside the EnvVarName union block.  Stop when the union ends (;).
const unionMatch = configTypesSource.match(
  /export type EnvVarName\s*=\s*([\s\S]*?);/
);

/** @type {Set<string>} */
const codeVars = new Set();

if (unionMatch) {
  const unionBody = unionMatch[1];
  for (const m of unionBody.matchAll(/\|\s*"([A-Z0-9_]+)"/g)) {
    codeVars.add(m[1]);
  }
} else {
  // Fallback: grep env["VAR"] usages across config directory
  console.warn(
    "[audit-env] WARNING: EnvVarName union not found; falling back to " +
    'env["VAR"] grep in src/config/'
  );
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    "grep",
    ["-roh", 'env["[A-Z0-9_]\\+"]', "src/config/"],
    { cwd: root, encoding: "utf8" }
  );
  const raw = result.stdout ?? "";
  for (const m of raw.matchAll(/"([A-Z0-9_]+)"/g)) {
    codeVars.add(m[1]);
  }
}

// ---------------------------------------------------------------------------
// 2. Extract documented var names from .env.example
// ---------------------------------------------------------------------------
const envExamplePath = resolve(root, ".env.example");
const envExampleSource = readFileSync(envExamplePath, "utf8");

/** @type {Set<string>} */
const docVars = new Set();

for (const line of envExampleSource.split("\n")) {
  const trimmed = line.trim();
  // Skip comments and blank lines
  if (!trimmed || trimmed.startsWith("#")) continue;
  // Match  VAR_NAME=...
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx > 0) {
    const key = trimmed.slice(0, eqIdx).trim();
    if (/^[A-Z0-9_]+$/.test(key)) {
      docVars.add(key);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Compute gaps
// ---------------------------------------------------------------------------
const inCodeNotDoc = [...codeVars].filter((v) => !docVars.has(v)).sort();
const inDocNotCode = [...docVars].filter((v) => !codeVars.has(v)).sort();

// ---------------------------------------------------------------------------
// 4. Report
// ---------------------------------------------------------------------------
console.log("=== Strada.Brain — Env-Var Coverage Audit ===\n");
console.log(`Config vars (EnvVarName): ${codeVars.size}`);
console.log(`Documented vars (.env.example): ${docVars.size}\n`);

if (inCodeNotDoc.length === 0) {
  console.log("✓  All code vars are documented in .env.example");
} else {
  console.log(
    `⚠  In code but NOT in .env.example (${inCodeNotDoc.length}):`
  );
  for (const v of inCodeNotDoc) console.log(`   - ${v}`);
}

console.log();

if (inDocNotCode.length === 0) {
  console.log("✓  All .env.example vars are referenced in EnvVarName");
} else {
  console.log(
    `ℹ  In .env.example but NOT in EnvVarName (${inDocNotCode.length}):`
  );
  for (const v of inDocNotCode) console.log(`   - ${v}`);
}

console.log(
  "\n[advisory] This script is non-blocking — fix gaps at your convenience."
);

// Always exit 0 — this is advisory only.
process.exit(0);
