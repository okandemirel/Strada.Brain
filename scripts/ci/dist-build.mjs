/**
 * The "build dist/" gate of scripts/ci/gates.mjs.
 *
 * A few tests run the compiled output in dist/: scripts/backup.sh shells out
 * to dist/core/database-backup.js, and the live-verify scripts load their
 * provider and runner from dist/. Without dist/ they fail rather than skip, on
 * purpose: CI builds before it tests, and a skip would hide a reordered
 * workflow. A fresh worktree has no dist/, so the gates used to come up red
 * there for every agent whose change selected one of those tests, and the
 * agent spent its turn diagnosing the environment instead of its change.
 *
 * A test says it reads the build in its failure message: "run `npm run build`
 * before this test" (READS_BUILD). The gate builds only when such a test is
 * among the tests the gates will run (a contract detector, or one vitest's
 * `related` selects for the changed files) and dist/ is missing or older than
 * its inputs. A failed build is a red gate.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const NAME = "build dist/";

/**
 * How a test says it reads the compiled dist/: the message it fails with when
 * dist/ is absent. The tests write it inside a template literal, so in their
 * source the backticks are escaped.
 */
export const READS_BUILD = /\\?`npm run build\\?` before this test/;

const toPosix = (p) => p.split(path.sep).join("/");
const errorText = (error) => (error instanceof Error ? error.message : String(error));

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/** The test files (vitest's include: src/ and tests/) that say they read dist/, repo-relative. */
export function testsThatReadBuild(root) {
  const found = [];
  for (const top of ["src", "tests"]) {
    for (const file of walk(path.join(root, top))) {
      if (file.endsWith(".test.ts") && READS_BUILD.test(fs.readFileSync(file, "utf8"))) {
        found.push(toPosix(path.relative(root, file)));
      }
    }
  }
  return found.sort();
}

/**
 * dist/ against what it is built from (tsconfig.json and every non-test file
 * under src/). `npm run build` empties dist/ first, so its oldest file marks
 * when the last build began; an input changed after that makes dist/ stale.
 *
 * @returns {{ state: "missing" | "stale" | "fresh"; why: string }}
 */
export function distFreshness(root) {
  let builtAt = Infinity;
  for (const file of walk(path.join(root, "dist"))) builtAt = Math.min(builtAt, fs.statSync(file).mtimeMs);
  if (builtAt === Infinity) return { state: "missing", why: "dist/ is missing" };

  let newest = null;
  for (const file of [path.join(root, "tsconfig.json"), ...walk(path.join(root, "src"))]) {
    if (file.endsWith(".test.ts")) continue;
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (newest === null || mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
  }
  if (newest !== null && newest.mtimeMs > builtAt) {
    return { state: "stale", why: `${toPosix(path.relative(root, newest.file))} changed after dist/ was built` };
  }
  return { state: "fresh", why: "dist/ is up to date (built after the newest src/ change)" };
}

/** Which of `candidates` vitest's `related` selects for the `changed` files: the related-tests gate's own choice. */
export async function vitestRelated(root, changed, candidates) {
  // An empty filter list means "every test file" to vitest, not "none".
  if (candidates.length === 0 || changed.length === 0) return [];
  const { createVitest } = await import("vitest/node");
  const ctx = await createVitest(
    "test",
    { root, related: changed.map((file) => path.resolve(root, file)), watch: false, run: true },
    {},
    {},
  );
  try {
    const specs = await ctx.getRelevantTestSpecifications(candidates);
    return [...new Set(specs.map((spec) => toPosix(path.relative(root, spec.moduleId))))].sort();
  } finally {
    await ctx.close();
  }
}

function build(root, npm) {
  const started = Date.now();
  const r = spawnSync(npm, ["run", "build"], {
    cwd: root,
    // As CI's backend-only jobs build: no test that reads dist/ reads the web
    // portal, and a fresh worktree has no portal dependencies to build it with.
    env: { ...process.env, STRADA_ALLOW_PORTAL_BUILD_FAILURE: "1" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const seconds = Math.round((Date.now() - started) / 1000);
  if (r.status !== 0) {
    process.stdout.write(output);
    const cause = r.error ? errorText(r.error) : `exit ${r.status ?? r.signal}`;
    console.log(`  npm run build FAILED (${cause}) after ${seconds}s: the tests that read dist/ would run against no build`);
    return false;
  }
  const portal = /Portal (build|copy) FAILED/.test(output)
    ? "backend only: the web portal did not build here, and no test that reads dist/ needs it"
    : "backend and web portal";
  console.log(`  built dist/ with npm run build in ${seconds}s (${portal})`);
  return true;
}

/**
 * The gate: skipped with the reason, or a `run` that builds and says how it went.
 *
 * @param {{ root: string; detectors: string[]; changedSrc: string[]; npm: string; related?: typeof vitestRelated }} options
 */
export async function distBuildGate({ root, detectors, changedSrc, npm, related = vitestRelated }) {
  const readers = testsThatReadBuild(root);
  let selected = readers.filter((file) => detectors.includes(file));
  let note = "";
  if (changedSrc.length > 0 && readers.length > 0) {
    try {
      selected = [...new Set([...selected, ...(await related(root, changedSrc, readers))])];
    } catch (error) {
      // Not knowing which tests will run is no reason to skip the build.
      selected = readers;
      note = ` (vitest could not say which are related, so all are assumed: ${errorText(error)})`;
    }
  }
  if (selected.length === 0) {
    return { name: NAME, why: `no selected test reads dist/ (${readers.length} test file(s) in the repo do)`, skip: true };
  }
  const readersLine = `${selected.join(", ")} read${selected.length === 1 ? "s" : ""} it${note}`;
  const freshness = distFreshness(root);
  if (freshness.state === "fresh") return { name: NAME, why: `${freshness.why}; ${readersLine}`, skip: true };
  return { name: NAME, why: `${freshness.why}, and ${readersLine}`, run: () => build(root, npm) };
}
