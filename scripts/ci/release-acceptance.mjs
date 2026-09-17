#!/usr/bin/env node
/**
 * Release acceptance matrix (plan 6.13).
 *
 * The release checks that existed proved one thing each, and nothing proved the
 * three claims a release actually makes: that a CLEAN INSTALL works, that an
 * UPGRADE over an existing installation works, and that a RESTORE brings a lost
 * database back. The restore half was the worst of the three — `backup.sh` has
 * produced archives for weeks and `restoreRuntimeDatabases()` had tests, but no
 * script had ever run a restore, which makes "backups work" an untested claim
 * about the exact moment nobody can afford one.
 *
 * This runner performs the three scenarios it can really perform on this host
 * and prints a matrix. The two it cannot perform here are still rows: they read
 * NOT RUN, with the reason, because a scenario nobody ran must never be
 * summarized as a pass. Same rule inside a scenario: every step says what it
 * measured, and a step that could not be measured is printed as such.
 *
 *   node scripts/ci/release-acceptance.mjs [--only clean-install,restore]
 *                                          [--json <file>] [--keep]
 *                                          [--boot-timeout-s 180] [--port 3940]
 *                                          [--previous-release <tarball|dir>]
 *
 * Exit codes:
 *   0  every scenario that is runnable here was PROVEN
 *   1  a scenario FAILED
 *   2  prerequisites missing (no dist/ — run `npm run build`)
 *   3  a runnable scenario did NOT RUN (deselected, or a prerequisite inside it
 *      was absent). Not a pass: the release is unproven, not accepted.
 */

import Database from "better-sqlite3";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

/* ------------------------------------------------------------------------- *
 * The matrix itself — data, so the report and the exit code agree about what
 * the release is supposed to prove and what this host can prove.
 * ------------------------------------------------------------------------- */

export const ACCEPTANCE_SCENARIOS = [
  {
    id: "clean-install",
    title: "Clean install",
    runnableHere: true,
    scope:
      "the packed published file set (npm pack) extracted into an empty root and booted against a fresh home; dependencies supplied from this checkout's node_modules, so npm registry resolution is NOT exercised",
  },
  {
    id: "upgrade",
    title: "Upgrade from an older installed version",
    runnableHere: true,
    scope:
      "a REAL previous release (explicit --previous-release, a fixture tarball, or the npm registry/cache) is installed and booted, it writes state, this release's file set is laid over it in place, and the upgraded install boots against the SAME home with its databases intact; when no genuinely older release is reachable the scenario reports NOT RUN rather than stamping this release with an older version number; the auto-updater's own download/restart path is NOT exercised",
  },
  {
    id: "restore",
    title: "Backup, mutate, restore, verify",
    runnableHere: true,
    scope:
      "real SQLite databases in a temporary installation: scripts/backup.sh produces an archive, rows are deleted and a whole database file removed, scripts/restore.mjs restores from the archive and every row is compared back; remote sync (rclone/S3) is NOT exercised",
  },
  {
    id: "registry-install",
    title: "Install from the npm registry",
    runnableHere: false,
    whyNot:
      "requires the published strada-brain package and network access to the registry; not attempted here, so `npm i -g strada-brain` remains unproven by this runner",
  },
  {
    id: "docker-image",
    title: "Docker image boot",
    runnableHere: false,
    whyNot:
      "Docker is not available on this host, so the Dockerfile/docker-compose deployment is asserted only by the contract tests over those files, never executed",
  },
];

/* ------------------------------------------------------------------------- *
 * Pure reporting — exported and unit-tested, because the honesty rules live
 * here: NOT RUN must never collapse into PROVEN, and the exit code must not
 * call an unproven release accepted.
 * ------------------------------------------------------------------------- */

export function parseAcceptanceArgs(argv) {
  const flags = { only: null, json: null, keep: false, bootTimeoutS: 180, port: 3940, previousRelease: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep") { flags.keep = true; continue; }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    const value = eq > 0 ? arg.slice(eq + 1) : argv[i + 1];
    if (value === undefined || (eq < 0 && String(value).startsWith("--"))) {
      throw new Error(`Missing value for --${name}`);
    }
    if (eq < 0) i += 1;
    switch (name) {
      case "only": {
        const ids = String(value).split(",").map((id) => id.trim()).filter(Boolean);
        const known = new Set(ACCEPTANCE_SCENARIOS.map((scenario) => scenario.id));
        for (const id of ids) {
          if (!known.has(id)) throw new Error(`Unknown scenario "${id}" — known: ${[...known].join(", ")}`);
        }
        flags.only = ids;
        break;
      }
      case "json": flags.json = path.resolve(String(value)); break;
      case "previous-release": flags.previousRelease = path.resolve(String(value)); break;
      case "boot-timeout-s": flags.bootTimeoutS = Number(value); break;
      case "port": flags.port = Number(value); break;
      default: throw new Error(`Unknown flag --${name}`);
    }
  }
  return flags;
}

/** Counts by outcome, split by whether the host can run the scenario at all. */
export function summarizeAcceptance(results) {
  const runnable = results.filter((result) => result.runnableHere);
  const proven = runnable.filter((result) => result.state === "proven");
  const failed = results.filter((result) => result.state === "failed");
  const notRun = runnable.filter((result) => result.state === "not-run");
  const notProvableHere = results.filter((result) => !result.runnableHere);
  const verdict = failed.length > 0
    ? `FAILED: ${failed.map((result) => result.id).join(", ")}`
    : notRun.length > 0
      ? `NOT PROVEN: ${notRun.map((result) => result.id).join(", ")} did not run`
      : `PROVEN: ${proven.length}/${runnable.length} runnable scenarios`;
  return {
    proven: proven.map((result) => result.id),
    failed: failed.map((result) => result.id),
    notRun: notRun.map((result) => result.id),
    notProvableHere: notProvableHere.map((result) => result.id),
    verdict,
  };
}

/**
 * 1 on a failure, 3 on a runnable scenario that did not run, 0 only when every
 * runnable scenario is proven. A scenario this host cannot run never produces a
 * pass and never produces a failure — it produces a printed NOT RUN row.
 */
export function exitCodeForAcceptance(results) {
  if (results.some((result) => result.state === "failed")) return 1;
  if (results.some((result) => result.runnableHere && result.state !== "proven")) return 3;
  return 0;
}

const STATE_LABEL = { proven: "PROVEN", failed: "FAILED", "not-run": "NOT RUN" };
const STEP_LABEL = { ok: "ok", failed: "FAILED", "not-measured": "NOT MEASURED" };

export function formatAcceptanceReport(results) {
  const summary = summarizeAcceptance(results);
  const lines = ["", "Release acceptance matrix", "=========================", ""];
  const width = Math.max(...results.map((result) => result.id.length));
  for (const result of results) {
    lines.push(`${result.id.padEnd(width)}  ${(STATE_LABEL[result.state] ?? result.state).padEnd(7)}  ${result.title}`);
    lines.push(`${" ".repeat(width)}  scope: ${result.runnableHere ? result.scope : result.whyNot}`);
    if (result.reason) lines.push(`${" ".repeat(width)}  reason: ${result.reason}`);
    for (const step of result.steps ?? []) {
      lines.push(`${" ".repeat(width)}    [${STEP_LABEL[step.state] ?? step.state}] ${step.name}${step.detail ? ` — ${step.detail}` : ""}`);
    }
    lines.push("");
  }
  lines.push(`Verdict: ${summary.verdict}.`);
  if (summary.notProvableHere.length > 0) {
    lines.push(`Not provable on this host (reported NOT RUN, never as a pass): ${summary.notProvableHere.join(", ")}.`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------------- *
 * Scenario machinery
 * ------------------------------------------------------------------------- */

class ScenarioRun {
  constructor(scenario) {
    this.scenario = scenario;
    this.steps = [];
    this.startedAt = Date.now();
  }

  /** Record a measured step. `fn` returning a string adds detail. */
  step(name, fn) {
    try {
      const detail = fn();
      this.steps.push({ name, state: "ok", ...(detail ? { detail: String(detail) } : {}) });
      return true;
    } catch (err) {
      this.steps.push({ name, state: "failed", detail: err.message });
      this.failure = `${name}: ${err.message}`;
      return false;
    }
  }

  /** A step nothing could look at. Printed as NOT MEASURED, never as ok. */
  unmeasured(name, detail) {
    this.steps.push({ name, state: "not-measured", detail });
  }

  proven() {
    return this.#result("proven");
  }

  failed(reason) {
    return this.#result("failed", reason ?? this.failure);
  }

  notRun(reason) {
    return this.#result("not-run", reason);
  }

  #result(state, reason) {
    return {
      id: this.scenario.id,
      title: this.scenario.title,
      runnableHere: this.scenario.runnableHere,
      scope: this.scenario.scope,
      whyNot: this.scenario.whyNot,
      state,
      ...(reason ? { reason } : {}),
      steps: this.steps,
      durationMs: Date.now() - this.startedAt,
    };
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    timeout: options.timeoutMs ?? 300_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { code: result.status, output, signal: result.signal, error: result.error };
}

/** Spawn the boot smoke — one boot check for every scenario, not three copies. */
function bootSmoke({ entry, installRoot, home, port, timeoutS }) {
  return run(process.execPath, [path.join(repoRoot, "scripts", "ci", "boot-smoke.mjs")], {
    env: {
      ...process.env,
      BOOT_SMOKE_ENTRY: entry,
      BOOT_SMOKE_INSTALL_ROOT: installRoot,
      BOOT_SMOKE_HOME: home,
      BOOT_SMOKE_PORT: String(port),
      BOOT_SMOKE_TIMEOUT_S: String(timeoutS),
    },
    timeoutMs: (timeoutS + 90) * 1000,
  });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** `4.2.922` → `4.2.921`; the older version an upgrade starts from. */
export function previousVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  assert(match, `Cannot derive an older version from "${version}"`);
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.0`;
  assert(major > 0, `Cannot derive an older version from "${version}"`);
  return `${major - 1}.0.0`;
}

/** Numeric semver-ish comparison, enough to prove the overlay moved forward. */
export function compareVersions(a, b) {
  const parse = (value) => /^(\d+)\.(\d+)\.(\d+)/u.exec(value)?.slice(1, 4).map(Number) ?? [0, 0, 0];
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Pack the published file set once; both install scenarios need it.
 *
 * `--ignore-scripts` deliberately skips prepack: the acceptance run must test
 * the dist/ that was built and verified, not silently rebuild a different one
 * halfway through.
 */
function packPublishedFileSet(ctx) {
  const dest = path.join(ctx.root, "pack");
  mkdirSync(dest, { recursive: true });
  const packed = run("npm", ["pack", "--ignore-scripts", "--pack-destination", dest]);
  assert(packed.code === 0, `npm pack failed: ${packed.output.trim().slice(-800)}`);
  const tarballs = readdirSync(dest).filter((name) => name.endsWith(".tgz"));
  assert(tarballs.length === 1, `expected one tarball in ${dest}, found ${tarballs.length}`);
  return path.join(dest, tarballs[0]);
}

/** Extract the tarball into `<into>/package` and link this checkout's deps. */
function installPackedFileSet(tarball, into) {
  mkdirSync(into, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", into], { stdio: ["ignore", "pipe", "pipe"] });
  const installRoot = path.join(into, "package");
  assert(existsSync(installRoot), `tarball did not contain package/: ${tarball}`);
  const modules = path.join(installRoot, "node_modules");
  if (!existsSync(modules)) symlinkSync(path.join(repoRoot, "node_modules"), modules, "dir");
  return installRoot;
}

/**
 * Read the version a release file set DECLARES — a directory (unpacked install)
 * or an npm-shaped tarball. It is read out of the artifact, never assumed.
 */
function releaseFileSetVersion(source) {
  if (statSync(source).isDirectory()) {
    const pkg = path.join(source, "package.json");
    assert(existsSync(pkg), `${source} contains no package.json`);
    return readJson(pkg).version;
  }
  const printed = execFileSync("tar", ["-xzOf", source, "package/package.json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(printed).version;
}

/** `npm pack <spec>` into a directory; used to fetch a real previous release. */
function npmPackSpec(spec, destDir) {
  mkdirSync(destDir, { recursive: true });
  const before = new Set(readdirSync(destDir));
  const packed = run("npm", ["pack", spec, "--ignore-scripts", "--pack-destination", destDir], {
    timeoutMs: 180_000,
  });
  if (packed.code !== 0) {
    return { ok: false, detail: `npm pack ${spec} failed (exit ${packed.code}): ${packed.output.trim().slice(-240)}` };
  }
  const added = readdirSync(destDir).filter((name) => name.endsWith(".tgz") && !before.has(name));
  if (added.length !== 1) {
    return { ok: false, detail: `npm pack ${spec} produced ${added.length} tarball(s)` };
  }
  return { ok: true, tarball: path.join(destDir, added[0]), detail: `npm pack ${spec}` };
}

/**
 * Find a release of this package that is GENUINELY OLDER than the one under
 * test (Codex round 12 #24).
 *
 * The upgrade scenario used to manufacture its "older" half: it extracted the
 * tarball under test, decremented the version string in package.json, booted
 * that, and laid the same tarball back over it. Both halves of the "upgrade"
 * were the code under test, so a broken real upgrade migration could not
 * possibly be detected — and the scenario still printed PROVEN.
 *
 * Older code has to come from somewhere real. In order:
 *   1. `--previous-release <path>` / `STRADA_PREVIOUS_RELEASE` — a tarball or an
 *      unpacked install of a previous release;
 *   2. a `*.tgz` in tests/fixtures/release-acceptance/ (a pinned historical
 *      file set committed for exactly this purpose);
 *   3. `npm pack strada-brain@<previous>` / `@latest` — the published release,
 *      from the registry or the local npm cache.
 *
 * Every candidate's version is read out of the artifact and compared: a file set
 * that is not older than the release under test is REFUSED, so a copy of the
 * current release can never pose as the older half. When nothing older is
 * reachable the caller is told, with every place that was looked at, and the
 * scenario reports NOT RUN (exit 3) — never a pass.
 */
export function resolvePreviousRelease({
  currentVersion,
  explicitPath = null,
  env = process.env,
  fixtureDir = path.join(repoRoot, "tests", "fixtures", "release-acceptance"),
  downloadDir = null,
  packSpec = npmPackSpec,
} = {}) {
  const looked = [];
  const candidates = [];

  const explicit = explicitPath ?? env["STRADA_PREVIOUS_RELEASE"] ?? null;
  if (explicit) {
    candidates.push({ source: explicit, provenance: `explicit --previous-release/STRADA_PREVIOUS_RELEASE ${explicit}` });
  } else {
    looked.push("no --previous-release path and no STRADA_PREVIOUS_RELEASE in the environment");
  }

  if (existsSync(fixtureDir)) {
    const tarballs = readdirSync(fixtureDir).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length === 0) looked.push(`no *.tgz previous-release fixture in ${fixtureDir}`);
    for (const name of tarballs) {
      candidates.push({ source: path.join(fixtureDir, name), provenance: `fixture tarball ${path.join(fixtureDir, name)}` });
    }
  } else {
    looked.push(`the fixture directory ${fixtureDir} does not exist`);
  }

  const evaluate = (candidate) => {
    let version;
    try {
      version = releaseFileSetVersion(candidate.source);
    } catch (err) {
      return { ok: false, detail: `${candidate.source}: could not read its package.json (${err.message})` };
    }
    if (!version) return { ok: false, detail: `${candidate.source}: its package.json declares no version` };
    if (compareVersions(version, currentVersion) >= 0) {
      return {
        ok: false,
        detail: `${candidate.source}: version ${version} is not older than the release under test (${currentVersion})`,
      };
    }
    return { ok: true, candidate: { ...candidate, version } };
  };

  const usable = [];
  for (const candidate of candidates) {
    const verdict = evaluate(candidate);
    if (verdict.ok) usable.push(verdict.candidate);
    else looked.push(verdict.detail);
  }
  if (usable.length > 0) {
    usable.sort((a, b) => compareVersions(b.version, a.version));
    const pick = usable[0];
    return { available: true, source: pick.source, version: pick.version, provenance: pick.provenance, looked };
  }

  if (env["STRADA_ACCEPTANCE_NO_REGISTRY"]) {
    looked.push("STRADA_ACCEPTANCE_NO_REGISTRY is set, so the npm registry/cache was not consulted");
  } else {
    const dest = downloadDir ?? mkdtempSync(path.join(tmpdir(), "strada-previous-release-"));
    const specs = [`strada-brain@${previousVersion(currentVersion)}`, "strada-brain@latest"];
    for (const spec of specs) {
      const fetched = packSpec(spec, dest);
      if (!fetched.ok) {
        looked.push(fetched.detail);
        continue;
      }
      const verdict = evaluate({ source: fetched.tarball, provenance: fetched.detail });
      if (verdict.ok) {
        const pick = verdict.candidate;
        return { available: true, source: pick.source, version: pick.version, provenance: pick.provenance, looked };
      }
      looked.push(verdict.detail);
    }
  }

  return {
    available: false,
    reason:
      `no previous release older than ${currentVersion} could be reached, so an upgrade from older code cannot be `
      + `measured on this host (supply one with --previous-release <tarball|dir> or commit a fixture tarball): `
      + looked.join("; "),
    looked,
  };
}

/** Extract/copy a release file set (tarball or unpacked dir) into `<into>/package`. */
function installReleaseFileSet(source, into) {
  if (statSync(source).isDirectory()) {
    mkdirSync(into, { recursive: true });
    const installRoot = path.join(into, "package");
    cpSync(source, installRoot, { recursive: true });
    const modules = path.join(installRoot, "node_modules");
    if (!existsSync(modules)) symlinkSync(path.join(repoRoot, "node_modules"), modules, "dir");
    return installRoot;
  }
  return installPackedFileSet(source, into);
}

/* --- scenario 1: clean install ------------------------------------------- */

function scenarioCleanInstall(ctx) {
  const scenario = ACCEPTANCE_SCENARIOS.find((s) => s.id === "clean-install");
  const runner = new ScenarioRun(scenario);

  if (!ctx.tarball) {
    return runner.notRun(ctx.packFailure ?? "the published file set could not be packed");
  }

  const installRoot = path.join(ctx.root, "clean", "package");
  const home = path.join(ctx.root, "clean-home");

  if (!runner.step("extract the packed file set into an empty root", () => {
    mkdirSync(home, { recursive: true });
    const root = installPackedFileSet(ctx.tarball, path.join(ctx.root, "clean"));
    assert(root === installRoot, `unexpected install root ${root}`);
    return installRoot;
  })) return runner.failed();

  if (!runner.step("published file set carries the CLI and the web dashboard", () => {
    const entry = path.join(installRoot, "dist", "index.js");
    const dashboard = path.join(installRoot, "dist", "channels", "web", "static", "index.html");
    assert(existsSync(entry), `${entry} is not in the published file set`);
    assert(existsSync(dashboard), `${dashboard} is not in the published file set`);
    const pkg = readJson(path.join(installRoot, "package.json"));
    assert(pkg.bin?.strada, "package.json declares no `strada` bin");
    ctx.packedVersion = pkg.version;
    return `v${pkg.version}, bin strada -> ${pkg.bin.strada}`;
  })) return runner.failed();

  if (!runner.step("the installed CLI reports its version", () => {
    const result = run(process.execPath, [path.join(installRoot, "dist", "index.js"), "--version"], {
      cwd: installRoot,
      timeoutMs: 120_000,
    });
    assert(result.code === 0, `--version exited ${result.code}: ${result.output.trim().slice(-400)}`);
    assert(
      result.output.includes(ctx.packedVersion),
      `--version printed ${JSON.stringify(result.output.trim().slice(0, 200))}, expected ${ctx.packedVersion}`,
    );
    return result.output.trim().split("\n").pop();
  })) return runner.failed();

  if (!runner.step("it boots against a fresh home and shuts down cleanly", () => {
    const result = bootSmoke({
      entry: path.join(installRoot, "dist", "index.js"),
      installRoot,
      home,
      port: ctx.port,
      timeoutS: ctx.bootTimeoutS,
    });
    assert(result.code === 0, `boot smoke exited ${result.code}: ${result.output.trim().slice(-1200)}`);
    return result.output.trim().split("\n").filter(Boolean).pop();
  })) return runner.failed();

  runner.unmeasured(
    "dependency resolution from the npm registry",
    "node_modules was symlinked from this checkout, so `npm install strada-brain` was not exercised",
  );
  return runner.proven();
}

/* --- scenario 2: upgrade ------------------------------------------------- */

export function scenarioUpgrade(ctx) {
  const scenario = ACCEPTANCE_SCENARIOS.find((s) => s.id === "upgrade");
  const runner = new ScenarioRun(scenario);

  if (!ctx.tarball) {
    return runner.notRun(ctx.packFailure ?? "the published file set could not be packed");
  }

  const installRoot = path.join(ctx.root, "upgrade", "package");
  const home = path.join(ctx.root, "upgrade-home");
  const memoryRoot = path.join(home, ".strada", "memory");
  const newer = readJson(path.join(repoRoot, "package.json")).version;

  // The older half of an upgrade must be OLDER CODE. Resolve it BEFORE anything
  // is installed or booted: if no real previous release is reachable, this host
  // cannot measure an upgrade and the scenario says so (NOT RUN, exit 3) instead
  // of manufacturing an "older" install out of the release under test.
  const previous = resolvePreviousRelease({
    currentVersion: newer,
    downloadDir: path.join(ctx.root, "previous-release"),
    ...(ctx.previousRelease ? { explicitPath: ctx.previousRelease } : {}),
    ...(ctx.previousReleaseOptions ?? {}),
  });
  if (!previous.available) return runner.notRun(previous.reason);
  const older = previous.version;

  let sentinelDb;
  let databasesBefore = [];

  if (!runner.step(`install the previous release ${older} (real older code)`, () => {
    mkdirSync(home, { recursive: true });
    const root = installReleaseFileSet(previous.source, path.join(ctx.root, "upgrade"));
    assert(root === installRoot, `unexpected install root ${root}`);
    const installed = readJson(path.join(installRoot, "package.json")).version;
    assert(
      installed === older,
      `the installed file set reports ${installed}, but ${previous.source} declared ${older}`,
    );
    assert(
      compareVersions(installed, newer) < 0,
      `${installed} is not older than the release under test (${newer}) — the upgrade would prove nothing`,
    );
    return `${installed} from ${previous.provenance} (the release under test is ${newer})`;
  })) return runner.failed();

  if (!runner.step(`the older install (${older}) boots and writes its home`, () => {
    const result = bootSmoke({
      entry: path.join(installRoot, "dist", "index.js"),
      installRoot,
      home,
      port: ctx.port + 2,
      timeoutS: ctx.bootTimeoutS,
    });
    assert(result.code === 0, `boot smoke exited ${result.code}: ${result.output.trim().slice(-1200)}`);
    return result.output.trim().split("\n").filter(Boolean).pop();
  })) return runner.failed();

  const databases = existsSync(memoryRoot)
    ? readdirSync(memoryRoot).filter((name) => name.endsWith(".db")).sort()
    : [];
  if (databases.length === 0) {
    // Nothing to carry across is not "the upgrade preserved state".
    return runner.notRun(
      `the older install created no databases under ${memoryRoot}, so there is no state whose survival an upgrade could prove`,
    );
  }

  if (!runner.step("plant a sentinel row in the older install's database", () => {
    databasesBefore = databases;
    sentinelDb = path.join(memoryRoot, databases.includes("memory.db") ? "memory.db" : databases[0]);
    const db = new Database(sentinelDb);
    try {
      db.exec("CREATE TABLE IF NOT EXISTS strada_acceptance_sentinel (id INTEGER PRIMARY KEY, note TEXT)");
      db.prepare("INSERT INTO strada_acceptance_sentinel (id, note) VALUES (1, ?)").run(`written by ${older}`);
    } finally {
      db.close();
    }
    return `${path.basename(sentinelDb)} (${databases.length} database(s) present: ${databases.join(", ")})`;
  })) return runner.failed();

  if (!runner.step("lay the new file set over the installed one", () => {
    const staging = path.join(ctx.root, "upgrade-new");
    const fresh = installPackedFileSet(ctx.tarball, staging);
    for (const entry of readdirSync(fresh)) {
      if (entry === "node_modules") continue;
      cpSync(path.join(fresh, entry), path.join(installRoot, entry), { recursive: true, force: true });
    }
    const installed = readJson(path.join(installRoot, "package.json")).version;
    assert(
      compareVersions(installed, older) > 0,
      `install root still reports ${installed}, which is not newer than ${older}`,
    );
    return `${older} -> ${installed}`;
  })) return runner.failed();

  if (!runner.step("the upgraded install boots against the SAME home", () => {
    const result = bootSmoke({
      entry: path.join(installRoot, "dist", "index.js"),
      installRoot,
      home,
      port: ctx.port + 4,
      timeoutS: ctx.bootTimeoutS,
    });
    assert(result.code === 0, `boot smoke exited ${result.code}: ${result.output.trim().slice(-1200)}`);
    return result.output.trim().split("\n").filter(Boolean).pop();
  })) return runner.failed();

  if (!runner.step("state written before the upgrade is still readable afterwards", () => {
    const db = new Database(sentinelDb, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT note FROM strada_acceptance_sentinel WHERE id = 1").get();
      assert(row?.note === `written by ${older}`, `sentinel row is ${JSON.stringify(row)}`);
    } finally {
      db.close();
    }
    const after = readdirSync(memoryRoot).filter((name) => name.endsWith(".db")).sort();
    const lost = databasesBefore.filter((name) => !after.includes(name));
    assert(lost.length === 0, `databases lost across the upgrade: ${lost.join(", ")}`);
    for (const name of after) {
      const db2 = new Database(path.join(memoryRoot, name), { readonly: true, fileMustExist: true });
      try {
        const verdict = db2.pragma("integrity_check")[0]?.integrity_check;
        assert(verdict === "ok", `${name} integrity_check: ${verdict}`);
      } finally {
        db2.close();
      }
    }
    return `sentinel intact; ${after.length} database(s) pass integrity_check`;
  })) return runner.failed();

  runner.unmeasured(
    "the auto-updater's own download and restart",
    "the file set was laid over the install directly; `npm i -g strada-brain@latest` and the updater's restart path were not exercised",
  );
  runner.unmeasured(
    "the previous release's own dependency tree",
    `node_modules was symlinked from this checkout, so ${older} booted against THIS release's dependencies; a dependency `
      + "upgrade that breaks the older code is not visible here",
  );
  return runner.proven();
}

/* --- scenario 3: backup -> mutate -> restore -> verify ------------------- */

function seedDatabase(file, rows) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS acceptance (id INTEGER PRIMARY KEY, payload TEXT)");
    const insert = db.prepare("INSERT INTO acceptance (id, payload) VALUES (?, ?)");
    for (const [id, payload] of rows) insert.run(id, payload);
  } finally {
    db.close();
  }
}

function readRows(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT id, payload FROM acceptance ORDER BY id").all();
  } finally {
    db.close();
  }
}

function scenarioRestore(ctx) {
  const scenario = ACCEPTANCE_SCENARIOS.find((s) => s.id === "restore");
  const runner = new ScenarioRun(scenario);

  const home = path.join(ctx.root, "restore-home");
  const stradaHome = path.join(home, ".strada");
  const memoryRoot = path.join(stradaHome, "memory");
  const project = path.join(ctx.root, "restore-project");
  const backupDir = path.join(ctx.root, "backups");
  const memoryDb = path.join(memoryRoot, "memory.db");
  const campaignsDb = path.join(memoryRoot, "campaigns.db");
  const hubOwnersDb = path.join(stradaHome, "hub-owners.db");
  const expected = {};
  let archive;

  const backupScript = path.join(repoRoot, "scripts", "backup.sh");
  if (!existsSync(backupScript)) {
    return runner.notRun(`${backupScript} is absent — nothing produces an archive to restore from`);
  }

  if (!runner.step("seed a temporary installation with real SQLite databases", () => {
    seedDatabase(memoryDb, [[1, "campaign state"], [2, "learned lesson"], [3, "identity"]]);
    seedDatabase(campaignsDb, [[1, "sprint ladder"]]);
    seedDatabase(hubOwnersDb, [[1, "chat->channel binding"]]);
    seedDatabase(path.join(project, ".strada", "delivery-packages.db"), [[1, "delivery revision"]]);
    expected.memory = readRows(memoryDb);
    expected.campaigns = readRows(campaignsDb);
    expected.hubOwners = readRows(hubOwnersDb);
    return `${memoryRoot} (memory.db, campaigns.db), ${stradaHome} (hub-owners.db)`;
  })) return runner.failed();

  if (!runner.step("scripts/backup.sh produces a verified archive", () => {
    const result = run("bash", [backupScript], {
      env: {
        ...process.env,
        // HOME and STRADA_HOME are redirected on purpose: the inventory includes
        // `<homedir>/.strada`, and an acceptance run must never read — or later
        // restore over — the operator's real databases.
        HOME: home,
        USERPROFILE: home,
        STRADA_HOME: stradaHome,
        MEMORY_DB_PATH: memoryRoot,
        UNITY_PROJECT_PATH: project,
        BACKUP_DIR: backupDir,
        RETENTION_DAYS: "3650",
        KEEP_COUNT: "0",
        RCLONE_REMOTE: "",
        AWS_S3_BUCKET: "",
        DISCORD_WEBHOOK_URL: "",
        SLACK_WEBHOOK_URL: "",
      },
      timeoutMs: 300_000,
    });
    assert(result.code === 0, `backup.sh exited ${result.code}: ${result.output.trim().slice(-1200)}`);
    const archives = readdirSync(backupDir).filter((name) => name.endsWith(".tar.gz")).sort();
    assert(archives.length === 1, `expected one archive in ${backupDir}, found ${archives.length}`);
    archive = path.join(backupDir, archives[0]);
    return `${archives[0]} (${result.output.match(/Database backed up/gu)?.length ?? 0} databases copied)`;
  })) return runner.failed();

  if (!runner.step("lose data: rows deleted and a whole database file removed", () => {
    const db = new Database(memoryDb);
    try {
      db.exec("DELETE FROM acceptance");
    } finally {
      db.close();
    }
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${campaignsDb}${suffix}`, { force: true });
    assert(readRows(memoryDb).length === 0, "memory.db still has rows after the delete");
    assert(!existsSync(campaignsDb), "campaigns.db still exists after the delete");
    return "memory.db emptied, campaigns.db deleted";
  })) return runner.failed();

  if (!runner.step("the checksum gate refuses a tampered copy instead of overwriting", () => {
    // The restore's own guard, proven rather than assumed: a copy whose bytes do
    // not match its .sha256 must not reach a live database.
    const tampered = path.join(ctx.root, "tampered");
    mkdirSync(tampered, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "-C", tampered], { stdio: ["ignore", "pipe", "pipe"] });
    const extracted = readdirSync(tampered).find((name) => existsSync(path.join(tampered, name, "databases.manifest.json")));
    assert(extracted, `extracted archive has no databases.manifest.json: ${tampered}`);
    const dir = path.join(tampered, extracted);
    const manifest = readJson(path.join(dir, "databases.manifest.json"));
    const victim = path.join(dir, manifest.databases[0].backup);
    writeFileSync(victim, "corrupted");
    const result = run(process.execPath, [path.join(repoRoot, "scripts", "restore.mjs"), "--backup-dir", dir]);
    assert(result.code === 1, `restore accepted a tampered copy (exit ${result.code}): ${result.output.trim().slice(-600)}`);
    assert(
      /refusing to overwrite live databases/u.test(result.output),
      `restore did not say why it refused: ${result.output.trim().slice(-600)}`,
    );
    assert(readRows(memoryDb).length === 0, "the refused restore still wrote to memory.db");
    return "exit 1, live databases untouched";
  })) return runner.failed();

  if (!runner.step("scripts/restore.mjs restores from the archive", () => {
    const result = run(process.execPath, [path.join(repoRoot, "scripts", "restore.mjs"), "--archive", archive], {
      env: { ...process.env, HOME: home, USERPROFILE: home, STRADA_HOME: stradaHome },
    });
    assert(result.code === 0, `restore exited ${result.code}: ${result.output.trim().slice(-1200)}`);
    assert(
      /checksum-verified/u.test(result.output),
      `restore did not report checksum verification: ${result.output.trim().slice(-600)}`,
    );
    const restored = result.output.match(/restore: restored /gu)?.length ?? 0;
    assert(restored > 0, "restore reported no restored databases");
    return `${restored} database(s) restored`;
  })) return runner.failed();

  if (!runner.step("every lost row is back and every database passes integrity_check", () => {
    assert(existsSync(campaignsDb), "campaigns.db was not restored");
    const memoryRows = readRows(memoryDb);
    assert(
      JSON.stringify(memoryRows) === JSON.stringify(expected.memory),
      `memory.db rows after restore: ${JSON.stringify(memoryRows)}`,
    );
    assert(
      JSON.stringify(readRows(campaignsDb)) === JSON.stringify(expected.campaigns),
      "campaigns.db rows do not match what was backed up",
    );
    assert(
      JSON.stringify(readRows(hubOwnersDb)) === JSON.stringify(expected.hubOwners),
      "hub-owners.db rows do not match what was backed up",
    );
    for (const file of [memoryDb, campaignsDb, hubOwnersDb]) {
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try {
        const verdict = db.pragma("integrity_check")[0]?.integrity_check;
        assert(verdict === "ok", `${path.basename(file)} integrity_check: ${verdict}`);
      } finally {
        db.close();
      }
    }
    // -wal sidecars must not be left behind: a stale one replays over the file.
    for (const file of [memoryDb, campaignsDb, hubOwnersDb]) {
      assert(!existsSync(`${file}-wal`), `${path.basename(file)}-wal survived the restore`);
    }
    return `${expected.memory.length} rows in memory.db, campaigns.db and hub-owners.db verified`;
  })) return runner.failed();

  // Project-owned databases are a newer backup surface; whether this build's
  // backup CLI covers them is reported, never assumed.
  const projectDb = path.join(project, ".strada", "delivery-packages.db");
  runner.unmeasured(
    "project-owned databases (<project>/.strada)",
    existsSync(projectDb)
      ? "seeded and left in place; this scenario verifies the memory root and the Strada home, not the project root"
      : "not present in the fixture",
  );
  return runner.proven();
}

/* ------------------------------------------------------------------------- *
 * Runner
 * ------------------------------------------------------------------------- */

const SCENARIO_IMPLEMENTATIONS = {
  "clean-install": scenarioCleanInstall,
  upgrade: scenarioUpgrade,
  restore: scenarioRestore,
};

async function main(argv) {
  let flags;
  try {
    flags = parseAcceptanceArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }

  const dist = path.join(repoRoot, "dist", "index.js");
  if (!existsSync(dist)) {
    process.stderr.write(`release-acceptance: ${dist} missing — run \`npm run build\` first\n`);
    return 2;
  }

  const root = mkdtempSync(path.join(tmpdir(), "strada-acceptance-"));
  const ctx = {
    root,
    port: flags.port,
    bootTimeoutS: flags.bootTimeoutS,
    previousRelease: flags.previousRelease,
  };
  const selected = (id) => !flags.only || flags.only.includes(id);

  if (selected("clean-install") || selected("upgrade")) {
    try {
      ctx.tarball = packPublishedFileSet(ctx);
      console.log(`release-acceptance: packed ${path.basename(ctx.tarball)}`);
    } catch (err) {
      ctx.packFailure = err.message;
      console.error(`release-acceptance: npm pack failed — ${err.message}`);
    }
  }

  const results = [];
  for (const scenario of ACCEPTANCE_SCENARIOS) {
    if (!scenario.runnableHere) {
      results.push({ ...scenario, state: "not-run", reason: scenario.whyNot, steps: [] });
      continue;
    }
    if (!selected(scenario.id)) {
      results.push({ ...scenario, state: "not-run", reason: "not selected by --only", steps: [] });
      continue;
    }
    console.log(`release-acceptance: running ${scenario.id}…`);
    const implementation = SCENARIO_IMPLEMENTATIONS[scenario.id];
    let result;
    try {
      result = implementation(ctx);
    } catch (err) {
      // An unexpected throw is a failure of the scenario, not a silent pass.
      result = {
        ...scenario,
        state: "failed",
        reason: `unexpected error: ${err.message}`,
        steps: [],
      };
    }
    results.push(result);
    console.log(`release-acceptance: ${scenario.id} → ${STATE_LABEL[result.state] ?? result.state}`);
  }

  const report = formatAcceptanceReport(results);
  console.log(report);

  if (flags.json) {
    mkdirSync(path.dirname(flags.json), { recursive: true });
    writeFileSync(
      flags.json,
      `${JSON.stringify({
        generatedAtIso: new Date().toISOString(),
        host: { platform: process.platform, node: process.versions.node },
        summary: summarizeAcceptance(results),
        scenarios: results,
      }, null, 2)}\n`,
    );
    console.log(`release-acceptance: report written to ${flags.json}`);
  }

  if (flags.keep) {
    console.log(`release-acceptance: temp root kept at ${root}`);
  } else {
    rmSync(root, { recursive: true, force: true });
  }

  return exitCodeForAcceptance(results);
}

/* c8 ignore start — CLI wiring; the reporting rules are unit-tested */
const invokedDirectly =
  process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
/* c8 ignore stop */
