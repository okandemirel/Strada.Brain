#!/usr/bin/env node
/**
 * Live verification of local model weights against the real Hugging Face hub.
 *
 * The unit suite never reaches huggingface.co, so four things were only ever
 * tested against fakes: that the runner's own weights fetch downloads a real
 * model, that it pins the commit the hub served in models.lock.json (CMP-13,
 * src/assets-local/weights-lock.ts), that the readiness check accepts the
 * weights at that pin, and that weights cached before the lock existed are
 * pinned again from the cache alone, offline (adoptDownloadedWeights in
 * src/assets-local/local-model-runner.ts). This script performs them, with the
 * COMPILED runner (dist/), on the smallest model in the catalog, in a throwaway
 * install root (STRADA_ASSETS_LOCAL_ROOT).
 *
 * The venv holds only what the fetch imports (huggingface_hub, or diffusers
 * for a model fetched as a pipeline folder), never the inference stack. So
 * "readiness" here is modelWeightsPresent, the weights half of
 * isModelInstalled; the venv/marker/source-clone half is not exercised.
 *
 * Adoption runs in a fresh process (the runner adopts once per process and
 * install root) under HF_HUB_OFFLINE=1, behind a guard that records and
 * refuses every socket, DNS lookup, fetch and child process; the guard proves
 * itself on loopback probes first, and adoption must leave its record empty.
 *
 *   node scripts/ci/live-verify-weights.mjs [--model <id>] [--root <empty dir>] [--keep]
 *
 * The install root is removed afterwards unless --keep is given.
 *
 * Exit codes (docs/RUNBOOK.md, "Checks you can run yourself"):
 *   0  every check ran and passed
 *   1  a check FAILED (the checks after it are NOT RUN)
 *   2  bad invocation, dist/ missing (run `npm run build`), or a Windows host
 *      (the runner's venv layout is POSIX)
 *   3  a check did NOT RUN without a failure before it: unproven, never a pass
 */

import childProcess, { spawnSync } from "node:child_process";
import dns from "node:dns";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..", "..");
const DIST = path.join(repoRoot, "dist");
const REQUIRED_DIST = ["assets-local/local-model-runner.js", "assets-local/model-catalog.js", "assets-local/weights-lock.js"];

const COMMIT_RE = /^[0-9a-f]{40}$/;
const ADOPT_RESULT_PREFIX = "LIVE_VERIFY_ADOPT_RESULT ";

/* ------------------------------------------------------------------------- *
 * What the run is: data, so the report and the exit code agree on it.
 * ------------------------------------------------------------------------- */

export const WEIGHTS_CHECKS = [
  { id: "model", title: "Smallest model in the catalog" },
  { id: "venv", title: "Fetch-only venv (no inference stack)" },
  { id: "download", title: "Runner weights fetch from the hub" },
  { id: "pin", title: "Download pin in models.lock.json" },
  { id: "readiness", title: "Readiness check at the pin" },
  { id: "adoption", title: "Offline re-pin from disk (adoptDownloadedWeights)" },
];

/** The catalog model that costs least to fetch: disk size first, then RAM, then catalog order. */
export function smallestModel(catalog) {
  return [...catalog]
    .map((spec, index) => ({ spec, index }))
    .sort((a, b) => a.spec.diskGb - b.spec.diskGb || a.spec.minRamGb - b.spec.minRamGb || a.index - b.index)[0]?.spec;
}

/**
 * What the runner's fetch_weights.py imports, and nothing else. Named files go
 * through huggingface_hub alone; the range is what a real TripoSR install
 * resolves (its requirements pin transformers==4.35.0, which caps the hub
 * below 1.0), so the verified client is the one users run. A pipeline folder
 * goes through diffusers, which brings its own compatible hub.
 */
export function fetchPackagesFor(spec) {
  return spec.weightFiles && spec.weightFiles.length > 0 ? ["huggingface_hub>=0.16.4,<1.0"] : ["diffusers"];
}

/** The pin the first download must have recorded: a full commit, from a download, for this repo. */
export function evaluateDownloadPin(lock, spec) {
  if (lock?.version !== 1) return { ok: false, detail: `models.lock.json has version ${JSON.stringify(lock?.version)}, expected 1` };
  const pin = lock.models?.[spec.id];
  if (!pin) return { ok: false, detail: `models.lock.json holds no pin for ${spec.id}` };
  const problems = [];
  if (typeof pin.revision !== "string" || !COMMIT_RE.test(pin.revision)) problems.push(`revision ${JSON.stringify(pin.revision)} is not a 40-hex commit`);
  if (pin.origin !== "download") problems.push(`origin is ${JSON.stringify(pin.origin)}, expected "download"`);
  if (pin.weightsRef !== spec.weightsRef) problems.push(`weightsRef is ${JSON.stringify(pin.weightsRef)}, expected ${JSON.stringify(spec.weightsRef)}`);
  return problems.length > 0
    ? { ok: false, detail: problems.join("; ") }
    : { ok: true, revision: pin.revision, detail: `${spec.id} pinned to ${pin.revision}, origin "download"` };
}

/**
 * Did adoption re-pin the downloaded commit from disk, without the network?
 * `child` is what the adoption process reported; `lock` the file afterwards.
 */
export function evaluateAdoption({ spec, downloaded, lock, child }) {
  if (!child) return { ok: false, detail: "the adoption process reported no result" };
  const problems = [];
  const probes = Object.entries(child.guardSelfTest ?? {});
  const unblocked = probes.filter(([, blocked]) => blocked !== true).map(([probe]) => probe);
  if (probes.length === 0) problems.push("the network guard's self-test did not run");
  else if (unblocked.length > 0) problems.push(`the network guard let through: ${unblocked.join(", ")}`);
  if ((child.attempts ?? []).length > 0) problems.push(`adoption tried network or process access: ${child.attempts.join(", ")}`);
  if (child.offline !== "1") problems.push("HF_HUB_OFFLINE was not 1 in the adoption process");
  if (child.error) problems.push(`adoption threw: ${child.error}`);
  if (child.outcome !== "adopted") {
    problems.push(`adoption outcome ${JSON.stringify(child.outcome ?? null)}${child.outcomeDetail ? ` (${child.outcomeDetail})` : ""}, expected "adopted"`);
  }
  const pin = lock?.models?.[spec.id];
  if (!pin) {
    problems.push("models.lock.json holds no pin after adoption");
  } else {
    if (pin.revision !== downloaded) problems.push(`re-pinned ${pin.revision}, not the downloaded ${downloaded}`);
    if (pin.origin !== "disk") problems.push(`origin is ${JSON.stringify(pin.origin)}, expected "disk"`);
    if (pin.weightsRef !== spec.weightsRef) problems.push(`weightsRef is ${JSON.stringify(pin.weightsRef)}, expected ${JSON.stringify(spec.weightsRef)}`);
  }
  if (child.readyAfter !== true) problems.push("the readiness check failed after adoption");
  if (problems.length > 0) return { ok: false, detail: problems.join("; ") };
  return {
    ok: true,
    detail: `re-pinned ${downloaded} (${child.outcomeDetail ?? "adopted"}), origin "disk"; 0 network/process attempts under HF_HUB_OFFLINE=1 and a guard that blocked all ${probes.length} self-test probes`,
  };
}

/** Counts by state, and the one-line verdict the log and the job summary share. */
export function summarizeChecks(checks) {
  const passed = checks.filter((check) => check.state === "pass").map((check) => check.id);
  const failed = checks.filter((check) => check.state === "fail").map((check) => check.id);
  const notRun = checks.filter((check) => check.state !== "pass" && check.state !== "fail").map((check) => check.id);
  const verdict = failed.length > 0
    ? `FAILED: ${failed.join(", ")}${notRun.length > 0 ? ` (not run after it: ${notRun.join(", ")})` : ""}`
    : notRun.length > 0
      ? `NOT RUN: ${notRun.join(", ")}`
      : `PASS: ${passed.length}/${checks.length} checks`;
  return { passed, failed, notRun, verdict };
}

/** 1 on a failure, 3 on a check that did not run, 0 only when every check passed. */
export function exitCodeForChecks(checks) {
  if (checks.some((check) => check.state === "fail")) return 1;
  if (checks.some((check) => check.state !== "pass")) return 3;
  return 0;
}

const STATE_LABEL = { pass: "PASS", fail: "FAIL", "not-run": "NOT RUN" };

export function formatWeightsReport(checks, context = {}) {
  const width = Math.max(...checks.map((check) => check.id.length));
  const lines = ["", "Live verify: local model weights", "================================"];
  if (context.model) lines.push(`model: ${context.model}`);
  lines.push("");
  for (const check of checks) {
    lines.push(`${check.id.padEnd(width)}  ${(STATE_LABEL[check.state] ?? check.state).padEnd(7)}  ${check.title}`);
    if (check.detail) lines.push(`${" ".repeat(width)}  ${check.detail.trim().split("\n").join(`\n${" ".repeat(width)}  `)}`);
  }
  lines.push("", `Verdict: ${summarizeChecks(checks).verdict}`);
  return lines.join("\n");
}

const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

export function formatWeightsStepSummary(checks, context = {}) {
  const lines = [`### Live verify: local weights — ${summarizeChecks(checks).verdict}`, ""];
  if (context.model) lines.push(`Model: ${cell(context.model)}`, "");
  lines.push("| Check | Result | Detail |", "|---|---|---|");
  for (const check of checks) {
    lines.push(`| ${cell(check.title)} | ${STATE_LABEL[check.state] ?? check.state} | ${cell(check.detail)} |`);
  }
  return `${lines.join("\n")}\n`;
}

export function parseWeightsArgs(argv) {
  const flags = { model: null, root: null, keep: false, phase: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep") { flags.keep = true; continue; }
    if (!["--model", "--root", "--phase"].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    i += 1;
    if (arg === "--model") flags.model = value;
    else if (arg === "--root") flags.root = path.resolve(value);
    else if (value === "adopt") flags.phase = value;
    else throw new Error(`Unknown phase: ${value}`);
  }
  return flags;
}

/**
 * The runner's own fetch. It is private in TypeScript (install() is the public
 * path, and install() also builds the whole inference stack), so it is reached
 * by name here; a rename fails the unit test that pins these names, not only
 * this manual run.
 */
export const RUNNER_FETCH_METHODS = ["fetchWeights", "envWithWeights"];

export function runnerFetch(RunnerClass) {
  const missing = RUNNER_FETCH_METHODS.filter((name) => typeof RunnerClass?.prototype?.[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`LocalModelRunner has no ${missing.join("/")} any more: update scripts/ci/live-verify-weights.mjs`);
  }
  return (runner, spec, onProgress) => runner.fetchWeights(spec, runner.envWithWeights(), onProgress);
}

/* ------------------------------------------------------------------------- *
 * The network guard for the adoption process.
 * ------------------------------------------------------------------------- */

/**
 * Replace every way this process could reach the network or start another
 * process (which could) with a function that records the attempt and throws.
 * net.Socket.prototype.connect is the choke point every TCP/TLS client goes
 * through, fetch and http(s) included; the rest name the attempt precisely.
 * syncBuiltinESMExports makes `import { spawn } from "node:child_process"` in
 * modules loaded afterwards see the guard too.
 */
export function installNetworkGuard() {
  const attempts = [];
  const guard = (target, key, label) => {
    target[key] = function blockedByLiveVerify() {
      attempts.push(label);
      throw new Error(`blocked by the live-verify network guard: ${label}`);
    };
  };
  guard(net.Socket.prototype, "connect", "net.Socket.connect");
  guard(net, "connect", "net.connect");
  guard(net, "createConnection", "net.createConnection");
  guard(tls, "connect", "tls.connect");
  for (const mod of [["http", http], ["https", https]]) {
    guard(mod[1], "request", `${mod[0]}.request`);
    guard(mod[1], "get", `${mod[0]}.get`);
  }
  for (const key of ["lookup", "resolve", "resolve4", "resolve6"]) {
    guard(dns, key, `dns.${key}`);
    guard(dns.promises, key, `dns.promises.${key}`);
  }
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    guard(childProcess, key, `child_process.${key}`);
  }
  guard(globalThis, "fetch", "fetch");
  syncBuiltinESMExports();

  /** Each probe must be refused by the guard itself, not by a closed port. Loopback only. */
  const selfTest = async () => {
    const probes = {
      fetch: () => fetch("http://127.0.0.1:9/"),
      "net.Socket.connect": () => new net.Socket().connect(9, "127.0.0.1"),
      "https.get": () => https.get("https://127.0.0.1:9/"),
      "dns.lookup": () => dns.lookup("localhost", () => undefined),
      "child_process.spawn (ESM import)": async () => (await import("node:child_process")).spawn(process.execPath, ["--version"]),
    };
    const results = {};
    for (const [name, probe] of Object.entries(probes)) {
      try {
        const handle = await probe();
        handle?.destroy?.();
        handle?.kill?.();
        results[name] = false;
      } catch (err) {
        results[name] = err instanceof Error && err.message.startsWith("blocked by the live-verify network guard");
      }
    }
    // The probes' own attempts are not the adoption's.
    attempts.length = 0;
    return results;
  };
  return { attempts, selfTest };
}

/* ------------------------------------------------------------------------- *
 * Side effects: the run itself.
 * ------------------------------------------------------------------------- */

class CheckRun {
  constructor() {
    this.checks = WEIGHTS_CHECKS.map((check) => ({ ...check, state: "not-run" }));
  }

  /** Run one check; after a failure every later check stays NOT RUN, with the reason. */
  async run(id, fn) {
    const check = this.checks.find((entry) => entry.id === id);
    if (this.checks.some((entry) => entry.state === "fail")) {
      check.detail = "not run: an earlier check failed";
      return;
    }
    try {
      check.detail = String((await fn()) ?? "");
      check.state = "pass";
    } catch (err) {
      check.detail = err instanceof Error ? err.message : String(err);
      check.state = "fail";
    }
    console.log(`live-verify-weights: [${STATE_LABEL[check.state]}] ${check.title}${check.detail ? ` — ${check.detail}` : ""}`);
  }
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

function runTool(command, args, timeoutMs) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args.join(" ")} failed (${result.error?.message ?? `exit ${result.status}`}): ${output.slice(-400)}`);
  }
  return output;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${bytes} bytes`;
}

/** Bytes of every file in one snapshot, following the cache's symlinks into blobs/. */
function snapshotBytes(dir) {
  let total = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else total += stat.size;
    }
  };
  walk(dir);
  return total;
}

async function importDist(rel) {
  return import(pathToFileURL(path.join(DIST, rel)).href);
}

/** The adoption process: guard first, then the runner, then adoption and readiness. */
async function adoptPhase(modelId) {
  const guard = installNetworkGuard();
  const report = { offline: process.env.HF_HUB_OFFLINE, guardSelfTest: await guard.selfTest() };
  try {
    // Imported AFTER the guard, so anything the runner did at import time is guarded as well.
    const runner = await importDist("assets-local/local-model-runner.js");
    const catalog = await importDist("assets-local/model-catalog.js");
    const spec = catalog.getModelSpec(modelId);
    must(spec !== undefined, `no catalog model ${modelId}`);
    const outcome = runner.adoptDownloadedWeights().find((entry) => entry.modelId === modelId);
    report.outcome = outcome?.outcome;
    report.outcomeDetail = outcome?.detail;
    report.revision = outcome?.revision;
    report.readyAfter = runner.modelWeightsPresent(spec);
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  }
  report.attempts = [...guard.attempts];
  process.stdout.write(`${ADOPT_RESULT_PREFIX}${JSON.stringify(report)}\n`);
  return 0;
}

async function main(argv) {
  let flags;
  try {
    flags = parseWeightsArgs(argv);
  } catch (err) {
    console.error(`live-verify-weights: ${err.message}`);
    return 2;
  }
  for (const rel of REQUIRED_DIST) {
    if (!existsSync(path.join(DIST, rel))) {
      console.error(`live-verify-weights: dist/${rel} is missing; run \`npm run build\` first`);
      return 2;
    }
  }
  // Adoption is pure Node (readdir, stat, the refs file), so it runs anywhere.
  if (flags.phase === "adopt") return adoptPhase(flags.model);
  if (process.platform === "win32") {
    console.error("live-verify-weights: the runner's venv layout (venv/bin/python3) is POSIX; run this on Linux or macOS");
    return 2;
  }

  if (flags.root && existsSync(flags.root) && readdirSync(flags.root).length > 0) {
    console.error(`live-verify-weights: --root ${flags.root} is not empty; the run needs a fresh install root`);
    return 2;
  }
  const root = flags.root ?? mkdtempSync(path.join(tmpdir(), "strada-live-weights-"));
  mkdirSync(root, { recursive: true });
  // Read at call time by the runner: every path below resolves under `root`.
  process.env.STRADA_ASSETS_LOCAL_ROOT = root;
  // Passed to the fetch through the runner's HF_* allowance; a progress bar
  // per chunk is noise in a captured log.
  process.env.HF_HUB_DISABLE_PROGRESS_BARS = "1";

  const catalogMod = await importDist("assets-local/model-catalog.js");
  const runnerMod = await importDist("assets-local/local-model-runner.js");
  const lockMod = await importDist("assets-local/weights-lock.js");
  const lockPath = path.join(root, lockMod.WEIGHTS_LOCK_FILE);
  const venvPython = path.join(root, "venv", "bin", "python3");
  const run = new CheckRun();
  const context = {};
  let spec;
  let downloaded;

  await run.run("model", () => {
    spec = flags.model ? catalogMod.getModelSpec(flags.model) : smallestModel(catalogMod.LOCAL_MODEL_CATALOG);
    must(spec !== undefined, flags.model ? `no catalog model "${flags.model}"` : "the catalog is empty");
    const files = spec.weightFiles?.length ? `files ${spec.weightFiles.join(", ")}` : "pipeline folder";
    context.model = `${spec.id} (${spec.weightsRef}, ${files}, ~${spec.diskGb} GB)`;
    return `${context.model}${flags.model ? ", chosen with --model" : ", smallest by disk size"}`;
  });

  await run.run("venv", () => {
    const python = process.env.LIVE_VERIFY_PYTHON ?? "python3";
    const version = runTool(python, ["--version"], 30_000);
    runTool(python, ["-m", "venv", path.join(root, "venv")], 180_000);
    const packages = fetchPackagesFor(spec);
    runTool(venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "--quiet", ...packages], 900_000);
    const hub = runTool(venvPython, ["-c", "import huggingface_hub; print(huggingface_hub.__version__)"], 60_000);
    return `${version}; installed ${packages.join(" ")} (huggingface_hub ${hub.split("\n").pop()})`;
  });

  await run.run("download", async () => {
    mkdirSync(path.join(root, "weights"), { recursive: true });
    const fetchWeights = runnerFetch(runnerMod.LocalModelRunner);
    const started = Date.now();
    const result = await fetchWeights(new runnerMod.LocalModelRunner(), spec, (line) => console.log(`live-verify-weights:   runner: ${line}`));
    must(result.ok, `the runner's fetch failed: ${result.detail}`);
    const seconds = Math.round((Date.now() - started) / 1000);
    // HF_ENDPOINT (a mirror) reaches the fetch through the runner's HF_* allowance: say which hub answered.
    return `${result.detail.replace(/\.$/u, "")}, from ${process.env.HF_ENDPOINT ?? "https://huggingface.co"} in ${seconds} s`;
  });

  await run.run("pin", () => {
    must(existsSync(lockPath), `${lockMod.WEIGHTS_LOCK_FILE} was not written`);
    const verdict = evaluateDownloadPin(readJson(lockPath), spec);
    must(verdict.ok, verdict.detail);
    downloaded = verdict.revision;
    // The project's own reader must agree with the raw file.
    const read = lockMod.readWeightsLock(lockPath);
    must(read.ok, `readWeightsLock refused the file: ${read.detail}`);
    must(lockMod.pinFor(read.pins, spec.id, spec.weightsRef)?.revision === downloaded, "readWeightsLock/pinFor do not return the recorded revision");
    // What the hub served is what landed in the cache: refs/main names it and
    // the snapshot is named after it.
    const hubDir = runnerMod.hfWeightsDir(spec.weightsRef);
    const snapshot = path.join(hubDir, "snapshots", downloaded);
    must(existsSync(snapshot), `no cache snapshot ${downloaded}`);
    const refsMain = readFileSync(path.join(hubDir, "refs", "main"), "utf8").trim();
    must(refsMain === downloaded, `refs/main names ${refsMain}, not the pinned ${downloaded}`);
    context.model = `${context.model}, commit ${downloaded}`;
    return `${verdict.detail}; refs/main and snapshots/${downloaded.slice(0, 12)}… agree (${formatBytes(snapshotBytes(snapshot))})`;
  });

  await run.run("readiness", () => {
    must(runnerMod.modelWeightsPresent(spec) === true, "modelWeightsPresent is false for the pinned download");
    // Control: a pin whose snapshot is not on disk must NOT read as ready, or
    // the check above would have passed without consulting the pin at all.
    const pin = lockMod.readWeightsLock(lockPath).pins[spec.id];
    const absent = downloaded === "0".repeat(40) ? "f".repeat(40) : "0".repeat(40);
    let readyAtAbsent;
    try {
      lockMod.recordWeightsPin(lockPath, spec.id, { ...pin, revision: absent });
      readyAtAbsent = runnerMod.modelWeightsPresent(spec);
    } finally {
      lockMod.recordWeightsPin(lockPath, spec.id, pin);
    }
    must(readyAtAbsent === false, "modelWeightsPresent was true with a pin whose snapshot is not on disk");
    must(runnerMod.modelWeightsPresent(spec) === true, "modelWeightsPresent is false after the pin was restored");
    return `modelWeightsPresent is true at ${downloaded.slice(0, 12)}…, and false with the pin moved to a commit not on disk`;
  });

  await run.run("adoption", () => {
    // An install cached before the lock existed: the weights on disk, no pin.
    const lock = readJson(lockPath);
    delete lock.models[spec.id];
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    const child = spawnSync(process.execPath, [scriptPath, "--phase", "adopt", "--model", spec.id], {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, STRADA_ASSETS_LOCAL_ROOT: root, HF_HUB_OFFLINE: "1" },
    });
    const line = (child.stdout ?? "").split("\n").find((entry) => entry.startsWith(ADOPT_RESULT_PREFIX));
    must(line !== undefined, `the adoption process printed no result (exit ${child.status}): ${`${child.stderr ?? ""}`.trim().slice(-400)}`);
    const verdict = evaluateAdoption({
      spec,
      downloaded,
      lock: existsSync(lockPath) ? readJson(lockPath) : undefined,
      child: JSON.parse(line.slice(ADOPT_RESULT_PREFIX.length)),
    });
    must(verdict.ok, verdict.detail);
    return verdict.detail;
  });

  const checks = run.checks;
  console.log(formatWeightsReport(checks, context));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatWeightsStepSummary(checks, context));
  if (flags.keep) console.log(`live-verify-weights: install root kept at ${root}`);
  else rmSync(root, { recursive: true, force: true });
  return exitCodeForChecks(checks);
}

/* c8 ignore start — CLI wiring; the reporting rules are unit-tested */
const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(scriptPath);
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
/* c8 ignore stop */
