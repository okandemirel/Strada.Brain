#!/usr/bin/env node
/**
 * run-tasks.mjs — the SWE-Sharp-Bench execution loop (plan item 6.11).
 *
 * Per task: clone the repo at `baseCommit` into a throwaway directory, apply the
 * task's `testPatch`, run the tests BEFORE anything is fixed, revert the test
 * patch, run the candidate, apply the patch the candidate produced, re-apply the
 * test patch, run `dotnet test` with a TRX logger, and feed the TRX to the
 * scorer that already existed (`src/bench/swe-sharp-resolution.ts`). Scoring is
 * not reimplemented here.
 *
 * HONESTY CONTRACT
 *   - A task that did not run is NOT a failed task and NOT a pass. It is
 *     reported as `not-run` with a named reason and it stays out of the rate's
 *     denominator. The exit code says so: 3.
 *   - A candidate that produced no patch IS scored. "The agent declined" and
 *     "the harness broke" are different columns.
 *   - FAIL_TO_PASS is verified to FAIL first. The pre-patch run is what makes
 *     "resolved" mean "fixed" instead of "was already green". Skip it with
 *     `--no-baseline` and every pass is reported UNPROVEN and exits 3.
 *   - The gold patch is a CONTROL candidate (`--candidate gold`): it measures
 *     whether this harness can recognise a known-good fix. It is never an agent
 *     score and the report labels it.
 *   - Competitor comparison (Hermes v0.21.2, Bezi 1.36.0) is NOT MEASURED:
 *     neither is installed here and neither publishes a score on this benchmark.
 *
 * Exit codes (same contract as scripts/eval/learning-eval.mjs):
 *   0  every requested task RAN and the run met its budget
 *   1  the run happened and regressed below its floor
 *   2  bad invocation / unreadable task set / harness error
 *   3  a requested task did NOT run, or a pass could not be proven
 *
 * Usage:
 *   node scripts/bench/swe-sharp/run-tasks.mjs --task autofac__autofac-1362 --candidate gold
 *   node scripts/bench/swe-sharp/run-tasks.mjs --candidate 'my-agent --fix'
 *   node scripts/bench/swe-sharp/run-tasks.mjs --limit 5 --json --report run.json
 *
 * The candidate contract (`--candidate <command>`, run with cwd = the checkout):
 *   STRADA_BENCH_INSTANCE_ID   task id
 *   STRADA_BENCH_REPO          owner/name
 *   STRADA_BENCH_BASE_COMMIT   the commit the checkout is at
 *   STRADA_BENCH_WORKDIR       the checkout (same as cwd)
 *   STRADA_BENCH_PROBLEM_FILE  problem statement, written OUTSIDE the checkout
 *   STRADA_BENCH_PATCH_OUT     where to write a unified diff, if it prefers that
 *   STRADA_BENCH_TIMEOUT_MS    the budget it will be killed at
 * Either write a diff to $STRADA_BENCH_PATCH_OUT or just edit the working tree;
 * the harness takes `git diff` when no patch file was written.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_TASKS = path.join(REPO_ROOT, "benchmarks", "swe-sharp", "tasks.json");

// ─── module loading ─────────────────────────────────────────────────────────
// src/ is the source of truth, loaded through tsx so the code that runs is the
// code the tests cover. A stale dist/ silently running instead would make the
// unit tests meaningless, so a tsx failure falls back to dist explicitly and
// says it did.

async function loadBenchModules() {
  const srcFile = (name) => pathToFileURL(path.join(REPO_ROOT, "src", "bench", `${name}.ts`)).href;
  const distFile = (name) => pathToFileURL(path.join(REPO_ROOT, "dist", "bench", `${name}.js`)).href;
  let registered = false;
  try {
    const api = await import("tsx/esm/api");
    api.register();
    registered = true;
  } catch {
    registered = false;
  }
  const load = (name) => import(registered ? srcFile(name) : distFile(name));
  return {
    from: registered ? "src (tsx)" : "dist",
    runner: await load("swe-sharp-runner"),
    trx: await load("trx-report"),
    dataset: await load("swe-sharp-dataset"),
  };
}

// ─── args ───────────────────────────────────────────────────────────────────

const USAGE = `run-tasks.mjs — SWE-Sharp-Bench execution loop

  --tasks <path>            pinned task set (default benchmarks/swe-sharp/tasks.json)
  --task <id>               run only this task (repeatable)
  --limit <n>               run the first n tasks of the set
  --candidate <cmd|gold>    candidate command, or "gold" for the control run
  --candidate-timeout <ms>  default 900000
  --test-timeout <ms>       per dotnet test invocation, default 1800000
  --no-baseline             skip the pre-patch run (every pass is then UNPROVEN)
  --no-filter               run whole test projects instead of only required tests
  --framework <tfm>         force a target framework
  --project <path>          force the test project/solution, relative to the checkout
  --cache-dir <path>        clone + work cache (default $TMPDIR/strada-swe-sharp)
  --keep                    keep the checkouts for inspection
  --min-resolved-rate <r>   floor; below it the run exits 1
  --allow-unproven          do not exit 3 on a pass whose fail→pass was not observed
  --json                    machine-readable result on stdout
  --report <path>           write the JSON result to a file

exit 0 ran and met budget · 1 ran and regressed · 2 bad invocation · 3 a task did NOT run`;

function parseArgs(argv) {
  const args = {
    tasks: DEFAULT_TASKS,
    only: [],
    limit: null,
    candidate: null,
    candidateTimeout: 900_000,
    testTimeout: 1_800_000,
    baseline: true,
    filter: true,
    framework: null,
    project: null,
    cacheDir: path.join(os.tmpdir(), "strada-swe-sharp"),
    keep: false,
    minResolvedRate: null,
    allowUnproven: false,
    json: false,
    report: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--tasks": args.tasks = path.resolve(next()); break;
      case "--task": args.only.push(next()); break;
      case "--limit": args.limit = Number(next()); break;
      case "--candidate": args.candidate = next(); break;
      case "--candidate-timeout": args.candidateTimeout = Number(next()); break;
      case "--test-timeout": args.testTimeout = Number(next()); break;
      case "--no-baseline": args.baseline = false; break;
      case "--no-filter": args.filter = false; break;
      case "--framework": args.framework = next(); break;
      case "--project": args.project = next(); break;
      case "--cache-dir": args.cacheDir = path.resolve(next()); break;
      case "--keep": args.keep = true; break;
      case "--min-resolved-rate": args.minResolvedRate = Number(next()); break;
      case "--allow-unproven": args.allowUnproven = true; break;
      case "--json": args.json = true; break;
      case "--report": args.report = path.resolve(next()); break;
      case "--help": case "-h": args.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  if (args.limit !== null && (!Number.isFinite(args.limit) || args.limit < 1)) {
    throw new Error("--limit must be a positive number");
  }
  if (args.minResolvedRate !== null && !(args.minResolvedRate >= 0 && args.minResolvedRate <= 1)) {
    throw new Error("--min-resolved-rate must be between 0 and 1");
  }
  return args;
}

// ─── process helpers ────────────────────────────────────────────────────────

const GIT = process.env.STRADA_BENCH_GIT ?? "git";
const DOTNET = process.env.STRADA_BENCH_DOTNET ?? "dotnet";

function run(cmd, cmdArgs, options = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
    env: {
      ...process.env,
      // Never block a benchmark run on an interactive credential prompt: a
      // hanging clone looks identical to a slow one until the whole run is dead.
      GIT_TERMINAL_PROMPT: "0",
      ...(options.env ?? {}),
    },
  });
  const timedOut = res.error?.code === "ETIMEDOUT" || res.signal === "SIGTERM";
  return {
    ok: !timedOut && res.status === 0,
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    timedOut,
    error: res.error ? String(res.error.message ?? res.error) : null,
  };
}

const git = (cwd, gitArgs, options = {}) => run(GIT, ["-C", cwd, ...gitArgs], options);

function tail(text, lines = 12) {
  return text.trim().split("\n").slice(-lines).join("\n");
}

// ─── clone ──────────────────────────────────────────────────────────────────

const NETWORK_ERROR =
  /could not resolve host|couldn't resolve host|network is (down|unreachable)|connection (timed out|refused|reset)|operation timed out|temporary failure in name resolution|ssl|proxy/i;

/**
 * Fetches one commit into a per-repo bare cache, then materialises a checkout.
 *
 * A bare cache per repository, outside the working tree, is what makes a second
 * task on the same repo cheap and a re-run offline-capable. `--depth 1` on an
 * explicit sha is the whole history this benchmark needs; a full clone of efcore
 * or Avalonia is gigabytes for one commit.
 */
function materialiseCheckout(task, cacheDir, repoDir, url) {
  const slug = task.repo.replace(/[^A-Za-z0-9._-]/g, "__");
  const bare = path.join(cacheDir, "repos", `${slug}.git`);
  if (!fs.existsSync(bare)) {
    fs.mkdirSync(bare, { recursive: true });
    const init = run(GIT, ["init", "--bare", "--quiet", bare]);
    if (!init.ok) return { reason: "harness-error", detail: `git init --bare failed: ${tail(init.stderr, 3)}` };
  }
  // The task row was validated (parseSweSharpTasks); `--end-of-options` keeps
  // git from reading a positional as an option all the same.
  const has = git(bare, ["cat-file", "-e", "--end-of-options", `${task.baseCommit}^{commit}`]);
  if (!has.ok) {
    const fetched = git(bare, ["fetch", "--quiet", "--depth", "1", "--end-of-options", url, task.baseCommit], {
      timeout: 600_000,
    });
    if (!fetched.ok) {
      const text = `${fetched.stderr}\n${fetched.error ?? ""}`;
      return {
        reason: NETWORK_ERROR.test(text) ? "no-network" : "clone-failed",
        detail: `fetching ${task.baseCommit} from ${url}: ${tail(text, 4) || "timed out"}`,
      };
    }
  }
  fs.mkdirSync(repoDir, { recursive: true });
  const init = run(GIT, ["init", "--quiet", repoDir]);
  if (!init.ok) return { reason: "harness-error", detail: `git init failed: ${tail(init.stderr, 3)}` };
  const fetch = git(repoDir, ["fetch", "--quiet", "--depth", "1", "--end-of-options", bare, task.baseCommit], {
    timeout: 600_000,
  });
  if (!fetch.ok) {
    return { reason: "clone-failed", detail: `local fetch failed: ${tail(fetch.stderr, 4)}` };
  }
  const checkout = git(repoDir, ["checkout", "--quiet", "FETCH_HEAD"]);
  if (!checkout.ok) {
    return { reason: "clone-failed", detail: `checkout failed: ${tail(checkout.stderr, 4)}` };
  }
  return null;
}

// ─── patches ────────────────────────────────────────────────────────────────

function applyPatch(repoDir, patchText, label, { reverse = false } = {}) {
  const file = path.join(repoDir, "..", `${label}.patch`);
  fs.writeFileSync(file, patchText.endsWith("\n") ? patchText : `${patchText}\n`);
  const base = ["apply", "--whitespace=nowarn", ...(reverse ? ["-R"] : []), file];
  const first = git(repoDir, base);
  if (first.ok) return { ok: true };
  // --3way needs the blobs the patch's index line names, which a shallow fetch
  // may not have; it is the fallback, not the default.
  const threeWay = git(repoDir, ["apply", "--whitespace=nowarn", "--3way", ...(reverse ? ["-R"] : []), file]);
  if (threeWay.ok) return { ok: true, threeWay: true };
  return { ok: false, detail: tail(`${first.stderr}${threeWay.stderr}`, 6) || "git apply failed" };
}

/** The revision the candidate started from, so its work can be diffed against it. */
function currentRev(repoDir) {
  const res = git(repoDir, ["rev-parse", "HEAD"]);
  return res.ok ? res.stdout.trim() : null;
}

/**
 * Puts every path the testPatch touches back to its base state.
 *
 * The decision lives in `restoreTestPaths` (tested against real git). This is
 * only the file-system adapter. Note what it does NOT do: ask a diff which
 * paths changed. A diff does not mention an untracked file, and a candidate
 * whose patch adds a file the test patch also adds would have kept it, made
 * `git apply testPatch` fail with "already exists", and turned its own attempt
 * into a `not-run` — escaping measurement instead of being scored.
 */
function restoreTestFiles(repoDir, testPatch, baseRev, api) {
  if (!baseRev) return { restored: [], failed: [] };
  // Contained adapters: a path that resolves outside the checkout is never
  // read or deleted, whatever the task file says (CMP-3).
  return api.runner.restoreTestPaths({
    runGit: (gitArgs) => git(repoDir, gitArgs),
    baseRev,
    testPatch,
    ...api.runner.checkoutFileAdapters(repoDir),
  });
}

/**
 * Relaxes every global.json in the checkout so a newer SDK is allowed, and
 * COMMITS the change.
 *
 * The commit is the point. The harness edits a tracked file, and the candidate's
 * patch is read from `git diff` — so an uncommitted harness edit would be
 * attributed to the candidate, and a run with no agent at all would report a
 * patch. Committing it in the throwaway checkout keeps the diff honest.
 */
function relaxSdkPins(repoDir, relaxGlobalJson) {
  const deviations = [];
  const changedFiles = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name === "global.json") {
        const { text, changed } = relaxGlobalJson(fs.readFileSync(full, "utf8"));
        if (!changed) continue;
        fs.writeFileSync(full, text);
        changedFiles.push(path.relative(repoDir, full));
        deviations.push(
          `${path.relative(repoDir, full)}: SDK pin relaxed to rollForward=latestMajor (task authored pre-.NET-10)`,
        );
      }
    }
  };
  walk(repoDir, 0);
  if (changedFiles.length > 0) {
    const commit = git(repoDir, [
      "-c",
      "user.email=bench@strada.local",
      "-c",
      "user.name=strada-bench",
      "commit",
      "--quiet",
      "-m",
      "harness: relax SDK pin so the task builds on the installed SDK",
      "--",
      ...changedFiles,
    ]);
    if (!commit.ok) {
      deviations.push(
        `WARNING: the SDK-pin edit could not be committed (${tail(commit.stderr, 2)}), so it may appear in the candidate's diff`,
      );
    }
  }
  return deviations;
}

// ─── test discovery + execution ─────────────────────────────────────────────

function findFiles(dir, matcher, depth = 6, acc = []) {
  if (depth < 0) return acc;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules" || e.name === "bin" || e.name === "obj") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(full, matcher, depth - 1, acc);
    else if (matcher(e.name)) acc.push(full);
  }
  return acc;
}

function targetFrameworksOf(csprojPath) {
  try {
    const xml = fs.readFileSync(csprojPath, "utf8");
    const many = /<TargetFrameworks>([^<]*)<\/TargetFrameworks>/i.exec(xml);
    if (many) return many[1];
    const one = /<TargetFramework>([^<]*)<\/TargetFramework>/i.exec(xml);
    return one ? one[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs `dotnet test` for each target and parses every TRX it produced.
 *
 * A timeout is returned as a timeout, never as an empty report: an empty report
 * scores as "all required tests absent", which the scorer correctly calls a
 * failure — of the candidate. It was not the candidate's failure.
 */
function runTests({ repoDir, targets, phase, task, args, api, logDir, resultsDir }) {
  const { buildTestCommand, buildRequiredTestFilter, chooseFramework } = api.runner;
  const reports = [];
  const logs = [];
  let trxFilesFound = 0;
  let logText = "";
  const required = [...task.failToPass, ...task.passToPass];
  const filter = args.filter ? buildRequiredTestFilter(required) : undefined;
  for (const [index, target] of targets.entries()) {
    const trxName = `${phase}-${index}.trx`;
    const framework =
      args.framework ??
      (target.endsWith(".csproj") ? chooseFramework(targetFrameworksOf(path.join(repoDir, target))) : undefined);
    const cmd = buildTestCommand({
      target,
      trxName,
      resultsDir,
      ...(framework ? { framework } : {}),
      ...(filter ? { filter } : {}),
    });
    const res = run(DOTNET, cmd.args, {
      cwd: repoDir,
      env: cmd.env,
      timeout: args.testTimeout,
    });
    const logFile = path.join(logDir, `${phase}-${index}.log`);
    const text = `$ dotnet ${cmd.args.join(" ")}\n\n${res.stdout}\n${res.stderr}`;
    fs.writeFileSync(logFile, text);
    logText += `\n${text}`;
    logs.push({ target, framework: framework ?? null, exitCode: res.status, logFile });
    if (res.timedOut) {
      return { timedOut: true, logs, reports, trxFilesFound, logText, detail: `${target} exceeded ${args.testTimeout}ms` };
    }
    const trxPath = path.join(resultsDir, trxName);
    if (fs.existsSync(trxPath)) {
      trxFilesFound += 1;
      reports.push(api.trx.parseTrx(fs.readFileSync(trxPath, "utf8")));
    } else logs[logs.length - 1].missingTrx = true;
  }
  return { timedOut: false, logs, reports, trxFilesFound, logText };
}

// ─── the candidate ──────────────────────────────────────────────────────────

const STRADA_CANDIDATE_NOT_RUN =
  "no candidate was given. The default Strada candidate is NOT RUN here: a real " +
  "Strada worker run makes paid provider calls, and this harness must not spend " +
  "credit on its own. Pass --candidate '<command>' to evaluate an agent, or " +
  "--candidate gold for the reference-patch control run.";

function runCandidate({ args, task, api, repoDir, taskDir, logDir, baseRev }) {
  const { captureCandidatePatch } = api.runner;
  if (args.candidate === null || args.candidate === "strada") {
    return { kind: "unavailable", patch: null, patchSource: "none", unavailableReason: STRADA_CANDIDATE_NOT_RUN };
  }
  if (args.candidate === "gold") {
    // The control: does this harness recognise a known-good fix as resolved?
    return { kind: "gold", patch: task.goldPatch, patchSource: "gold", exitCode: 0, durationMs: 0 };
  }

  const problemFile = path.join(taskDir, "problem.md");
  fs.writeFileSync(problemFile, `# ${task.instanceId}\n\n${task.problemStatement}\n`);
  const patchOut = path.join(taskDir, "candidate.patch");
  const started = Date.now();
  const res = run(process.env.SHELL ?? "/bin/sh", ["-c", args.candidate], {
    cwd: repoDir,
    timeout: args.candidateTimeout,
    env: {
      STRADA_BENCH_INSTANCE_ID: task.instanceId,
      STRADA_BENCH_REPO: task.repo,
      STRADA_BENCH_BASE_COMMIT: task.baseCommit,
      STRADA_BENCH_WORKDIR: repoDir,
      STRADA_BENCH_PROBLEM_FILE: problemFile,
      STRADA_BENCH_PATCH_OUT: patchOut,
      STRADA_BENCH_TIMEOUT_MS: String(args.candidateTimeout),
    },
  });
  const durationMs = Date.now() - started;
  fs.writeFileSync(path.join(logDir, "candidate.log"), `$ ${args.candidate}\n\n${res.stdout}\n${res.stderr}`);
  if (res.timedOut) {
    return { kind: "command", patch: null, patchSource: "none", timedOut: true, durationMs, exitCode: res.status };
  }
  const patchFile = fs.existsSync(patchOut) ? fs.readFileSync(patchOut, "utf8") : "";
  // Against baseRev, not `git diff`: a candidate that staged, committed, or
  // branched its fix must not read as having produced nothing.
  const { patch, source } = captureCandidatePatch({
    runGit: (gitArgs) => git(repoDir, gitArgs),
    baseRev,
    patchFile,
  });
  return { kind: "command", patch, patchSource: source, exitCode: res.status, durationMs };
}

// ─── one task ───────────────────────────────────────────────────────────────

async function runTask(task, args, api) {
  const started = Date.now();
  // Contained: the directory is removed recursively when the task ends.
  const taskDir = api.runner.taskRunDir(args.cacheDir, task.instanceId, process.pid);
  const repoDir = path.join(taskDir, "repo");
  const logDir = path.join(taskDir, "logs");
  const resultsDir = path.join(taskDir, "trx");
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });

  const base = {
    instanceId: task.instanceId,
    repo: task.repo,
    failToPass: task.failToPass,
    passToPass: task.passToPass,
  };
  const finish = (extra) =>
    api.runner.classifyAttempt({ ...base, durationMs: Date.now() - started, ...extra });

  try {
    const cloneFailure = materialiseCheckout(task, args.cacheDir, repoDir, api.dataset.repoCloneUrl(task.repo));
    if (cloneFailure) return finish({ notRun: cloneFailure });

    const deviations = relaxSdkPins(repoDir, api.runner.relaxGlobalJson);

    // What to test. A matching test project is far cheaper than the solution,
    // and falling back to the solution is better than guessing wrong.
    let targets;
    if (args.project) {
      targets = [args.project];
    } else {
      const projects = findFiles(repoDir, (n) => n.endsWith(".csproj")).map((p) =>
        path.relative(repoDir, p),
      );
      // A project that merely roots the test name is often the library, not
      // the test assembly; testing it yields an empty report that scores as a
      // clean failure. Only projects that can actually run tests qualify.
      const testProjects = projects.filter((rel) => {
        try {
          return api.runner.looksLikeTestProject(fs.readFileSync(path.join(repoDir, rel), "utf8"));
        } catch {
          return false;
        }
      });
      const chosen = api.runner.chooseTestProjects(testProjects, [...task.failToPass, ...task.passToPass]);
      if (chosen.length > 0) targets = chosen;
      else {
        const solutions = findFiles(repoDir, (n) => /\.slnx?$/i.test(n), 3).map((p) =>
          path.relative(repoDir, p),
        );
        const solution = api.runner.chooseSolution(solutions);
        if (!solution) {
          return finish({
            notRun: {
              reason: "no-solution",
              detail: `no test project matched the required tests and no usable solution file was found (${solutions.length} candidate solutions)`,
            },
            deviations,
          });
        }
        targets = [solution];
      }
    }

    // ── does the checkout build AT ALL, before the test patch? ──
    // This is what separates "this repo does not build here" (not-run) from
    // "the added test does not compile until the fix lands" (the expected
    // failing baseline). Without it the two are indistinguishable.
    if (args.baseline) {
      for (const target of targets) {
        const framework =
          args.framework ??
          (target.endsWith(".csproj")
            ? api.runner.chooseFramework(targetFrameworksOf(path.join(repoDir, target)))
            : undefined);
        const cmd = api.runner.buildBuildCommand({ target, ...(framework ? { framework } : {}) });
        const res = run(DOTNET, cmd.args, { cwd: repoDir, env: cmd.env, timeout: args.testTimeout });
        fs.writeFileSync(
          path.join(logDir, `base-build-${targets.indexOf(target)}.log`),
          `$ dotnet ${cmd.args.join(" ")}\n\n${res.stdout}\n${res.stderr}`,
        );
        if (res.timedOut) {
          return finish({
            notRun: { reason: "baseline-timeout", detail: `building ${target} exceeded ${args.testTimeout}ms` },
            deviations,
          });
        }
        if (!res.ok) {
          return finish({
            notRun: {
              reason: "build-failed-before-candidate",
              detail: `${target} does not build at ${task.baseCommit} on the installed SDK (exit ${res.status}): ${tail(
                `${res.stdout}${res.stderr}`,
                4,
              )}`,
            },
            deviations,
          });
        }
      }
    }

    // ── baseline: the tests must be seen FAILING before the fix ──
    let baseline = { measured: false, reason: "--no-baseline was passed" };
    if (args.baseline) {
      const testPatchOn = applyPatch(repoDir, task.testPatch, "test-patch");
      if (!testPatchOn.ok) {
        return finish({ notRun: { reason: "test-patch-failed", detail: testPatchOn.detail }, deviations });
      }
      const pre = runTests({ repoDir, targets, phase: "pre", task, args, api, logDir, resultsDir });
      if (pre.timedOut) {
        return finish({ notRun: { reason: "baseline-timeout", detail: pre.detail }, deviations });
      }
      const preReport = api.runner.mergeTestReports(pre.reports);
      const preOutcome = api.runner.classifyTestRun({
        anyResults: !preReport.buildFailed,
        trxFilesFound: pre.trxFilesFound,
        logText: pre.logText,
      });
      if (preOutcome === "runtime-unavailable" || preOutcome === "no-test-report") {
        // No test ever executed. Inferring a failing baseline from that would
        // let a mis-targeted or unsupported task be scored.
        return finish({
          notRun: {
            reason: preOutcome,
            detail: `pre-patch run on ${targets.join(", ")}: ${tail(pre.logText, 4)}`,
          },
          deviations,
        });
      }
      baseline = preOutcome === "build-failure"
        ? // The repo built a moment ago without the test patch, so this is the
          // added test failing to compile — a failing baseline, not a broken box.
          api.runner.baselineFromFailedTestPatchBuild(task.failToPass)
        : api.runner.checkBaseline(task.failToPass, preReport);
      // The candidate must not see the tests it has to satisfy.
      const off = applyPatch(repoDir, task.testPatch, "test-patch", { reverse: true });
      if (!off.ok) {
        return finish({
          notRun: { reason: "harness-error", detail: `could not revert the testPatch: ${off.detail}` },
          deviations,
        });
      }
      if ((baseline.alreadyPassing ?? []).length > 0) {
        // The task cannot show a fail→pass transition. Not the candidate's
        // problem, so the candidate is never run and nothing is scored.
        return finish({
          notRun: {
            reason: "fail-to-pass-already-passing",
            detail: `${baseline.alreadyPassing.join(", ")} passed before any patch`,
          },
          baseline,
          deviations,
        });
      }
    }

    // ── candidate ──
    // Recorded BEFORE the candidate runs: everything it does is measured
    // against this, however it chooses to leave the tree.
    const baseRev = currentRev(repoDir);
    if (!baseRev) {
      return finish({
        notRun: { reason: "harness-error", detail: "could not resolve HEAD before the candidate ran" },
        baseline,
        deviations,
      });
    }
    const candidate = runCandidate({ args, task, api, repoDir, taskDir, logDir, baseRev });
    if (candidate.kind === "unavailable" || candidate.timedOut) {
      return finish({ baseline, candidate, deviations });
    }
    if (candidate.patch === null) {
      return finish({ baseline, candidate, deviations });
    }

    let patchApplied = { ok: true };
    if (candidate.patchSource !== "working-tree") {
      patchApplied = applyPatch(repoDir, candidate.patch, "candidate");
      if (!patchApplied.ok) return finish({ baseline, candidate, patchApplied, deviations });
    }

    // ── score ──
    // The candidate's edits to the benchmark's own tests are discarded first,
    // so it can neither dodge the tests nor rewrite the assertions.
    const restoration = restoreTestFiles(repoDir, task.testPatch, baseRev, api);
    if (restoration.restored.length > 0) {
      deviations.push(
        `candidate edits to ${restoration.restored.length} test file(s) were discarded before scoring: ${restoration.restored.join(", ")}`,
      );
    }
    if (restoration.failed.length > 0) {
      // The tests could not be put back to their base state, so whatever the
      // suite reports next is not a measurement of the candidate.
      return finish({
        notRun: {
          reason: "harness-error",
          detail: `could not restore test file(s) to base: ${restoration.failed.join(", ")}`,
        },
        baseline,
        candidate,
        deviations,
      });
    }
    const testPatchOn = applyPatch(repoDir, task.testPatch, "test-patch");
    if (!testPatchOn.ok) {
      return finish({
        notRun: {
          reason: "test-patch-failed",
          detail: `the testPatch no longer applies after the candidate's patch: ${testPatchOn.detail}`,
        },
        baseline,
        candidate,
        deviations,
      });
    }
    const post = runTests({ repoDir, targets, phase: "post", task, args, api, logDir, resultsDir });
    if (post.timedOut) {
      return finish({ notRun: { reason: "test-timeout", detail: post.detail }, baseline, candidate, deviations });
    }
    const postReport = api.runner.mergeTestReports(post.reports);
    const postOutcome = api.runner.classifyTestRun({
      anyResults: !postReport.buildFailed,
      trxFilesFound: post.trxFilesFound,
      logText: post.logText,
    });
    if (postOutcome === "runtime-unavailable" || postOutcome === "no-test-report") {
      return finish({
        notRun: {
          reason: postOutcome,
          detail: `post-patch run on ${targets.join(", ")}: ${tail(post.logText, 4)}`,
        },
        baseline,
        candidate,
        deviations,
      });
    }
    return finish({ baseline, candidate, patchApplied, postReport, deviations });
  } catch (err) {
    return finish({ notRun: { reason: "harness-error", detail: String(err?.message ?? err) } });
  } finally {
    if (!args.keep) {
      try {
        fs.rmSync(taskDir, { recursive: true, force: true });
      } catch {
        /* a locked file is not worth failing a measured run over */
      }
    }
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${String(err.message)}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const api = await loadBenchModules();
  const { EXIT } = api.runner;

  let pinned;
  let tasks;
  try {
    pinned = JSON.parse(fs.readFileSync(args.tasks, "utf8"));
    if (!Array.isArray(pinned.tasks) || pinned.tasks.length === 0) throw new Error("no tasks in the file");
    // Every row is validated before any field reaches git, a URL or the disk.
    tasks = api.dataset.parseSweSharpTasks(pinned.tasks);
  } catch (err) {
    process.stderr.write(`cannot read task set ${args.tasks}: ${String(err.message ?? err)}\n`);
    return EXIT.USAGE;
  }

  if (args.only.length > 0) {
    const known = new Set(tasks.map((t) => t.instanceId));
    const missing = args.only.filter((id) => !known.has(id));
    if (missing.length > 0) {
      process.stderr.write(`no such task in ${args.tasks}: ${missing.join(", ")}\n`);
      return EXIT.USAGE;
    }
    tasks = tasks.filter((t) => args.only.includes(t.instanceId));
  }
  if (args.limit !== null) tasks = tasks.slice(0, args.limit);

  try {
    api.runner.assertCacheDirIsSafe(args.cacheDir, REPO_ROOT, os.homedir());
  } catch (err) {
    process.stderr.write(`${String(err.message)}\n`);
    return EXIT.USAGE;
  }
  fs.mkdirSync(args.cacheDir, { recursive: true });

  const dotnetVersion = run(DOTNET, ["--version"]);
  process.stderr.write(
    `swe-sharp: ${tasks.length} task(s), candidate=${args.candidate ?? "strada (NOT RUN)"}, ` +
      `baseline=${args.baseline ? "on" : "OFF"}, modules from ${api.from}, ` +
      `dotnet ${dotnetVersion.ok ? dotnetVersion.stdout.trim() : "NOT FOUND"}\n`,
  );

  const attempts = [];
  for (const task of tasks) {
    process.stderr.write(`— ${task.instanceId} (${task.repo}) …\n`);
    const attempt = await runTask(task, args, api);
    attempts.push(attempt);
    process.stderr.write(`  ${attempt.status}: ${attempt.reason}\n`);
  }

  const report = api.runner.buildRunReport(
    tasks.map((t) => t.instanceId),
    attempts,
    { control: args.candidate === "gold" },
  );
  const decision = api.runner.decideExitCode(report, {
    ...(args.minResolvedRate === null ? {} : { minResolvedRate: args.minResolvedRate }),
    requireFixProven: !args.allowUnproven,
  });

  const payload = {
    dataset: pinned.dataset ?? null,
    contentHash: pinned.contentHash ?? null,
    candidate: args.candidate ?? "strada (NOT RUN)",
    control: args.candidate === "gold",
    dotnet: dotnetVersion.ok ? dotnetVersion.stdout.trim() : null,
    baselineMeasured: args.baseline,
    verdict: decision.verdict,
    exitCode: decision.exitCode,
    reasons: decision.reasons,
    report,
    attempts,
  };
  if (args.report) fs.writeFileSync(args.report, `${JSON.stringify(payload, null, 2)}\n`);
  // In --json mode stdout is a document, not a log: a trailing human footer
  // makes `| jq` fail on an otherwise perfectly good run, so it goes to stderr.
  const footer = [
    `verdict: ${decision.verdict} (exit ${decision.exitCode})`,
    ...decision.reasons.map((r) => `  ${r}`),
  ].join("\n");
  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.stderr.write(`${footer}\n`);
  } else {
    process.stdout.write(`${api.runner.renderRunReport(report, attempts)}\n`);
    process.stdout.write(`\n${footer}\n`);
  }
  return decision.exitCode;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`swe-sharp harness error: ${String(err?.stack ?? err)}\n`);
    process.exit(2);
  });
