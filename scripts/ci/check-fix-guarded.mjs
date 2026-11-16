#!/usr/bin/env node
/**
 * A fix commit carries a test that turns red when the fix is undone.
 * Contract: docs/contracts/fix-needs-a-red-test.md, rule fix-has-a-red-test.
 *
 * A test written "to guard the fix" that stays green with the fix reverted
 * guards nothing. QA found that twice (board tasks #38 and #56), each time by
 * reverting the fix by hand. This script does that revert for every fix
 * commit in a range:
 *
 *   1. A commit is a fix when its subject is `fix:`, `fix(scope):` or `fix!:`
 *      (FIX_SUBJECT). Every other commit is not judged.
 *   2. Its changed files are sorted (classifyPath): test files, source files
 *      of the root package, and the rest (docs, config, the web portal, assets).
 *      A fix with no source file (docs only, config only, tests only) is exempt
 *      by rule, and so is one whose message carries a `Fix-Unguarded:` line
 *      with a sentence of reason.
 *   3. Otherwise the commit must touch a test file vitest runs (src/ or tests/).
 *   4. In a temporary worktree at the commit, those tests run once as the
 *      commit left them (they must pass), then once per source file with only
 *      that file put back as the parent had it. A file whose revert leaves the
 *      tests green is named: no test the commit touched depends on it.
 *
 * Only the test files the commit touched run, so the cost is one vitest run
 * per source file plus one, per fix commit.
 *
 *   node scripts/ci/check-fix-guarded.mjs --base origin/main --head HEAD
 *   node scripts/ci/check-fix-guarded.mjs --commits <sha>[,<sha>...]
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTestPath } from "./check-test-integrity.mjs";

/** `fix:`, `fix(scope):`, `fix!:`, any case, spaces around the tokens; never `fixup!` or `Fix the …`. */
export const FIX_SUBJECT = /^\s*fix\s*(?:\([^()\r\n]*\)\s*)?!?\s*:/i;
/** The explicit exemption, like Test-Weakened: it needs a sentence a reviewer can check. */
export const UNGUARDED_TRAILER = /^Fix-Unguarded:[ \t]*\S.{9,}$/m;

const DOC = /(?:^docs\/|\.(?:md|mdx|txt)$)/i;
const CONFIG =
  /(?:\.(?:json|jsonc|ya?ml|toml|ini|lock|env\.example)$|(?:^|\/)[^/]*\.config\.[cm]?[jt]s$|(?:^|\/)\.[^/]+$|^\.github\/)/i;
const CODE = /\.(?:[cm]?[jt]sx?|sh)$/;
/** Its own package with its own runner: the root vitest cannot run its tests. */
const OTHER_PACKAGE = /^web-portal\//;
/** vitest.config.ts include, read in this repository. */
const RUNNABLE_TEST = /^(?:src|tests)\/.+\.test\.ts$/;

/** @returns {"test" | "source" | "doc" | "config" | "other"} */
export function classifyPath(file) {
  if (isTestPath(file)) return "test";
  if (DOC.test(file)) return "doc";
  if (CONFIG.test(file)) return "config";
  if (OTHER_PACKAGE.test(file)) return "other";
  return CODE.test(file) ? "source" : "other";
}

export function isRunnableTest(file) {
  return RUNNABLE_TEST.test(file);
}

/**
 * The JavaScript a source text compiles to, without comments: two versions
 * that emit the same code differ only in types or comments, which no test at
 * run time can tell apart (the typecheck gate judges types).
 */
export async function emittedCode(text, file) {
  if (text === null) return "";
  if (!/\.[cm]?[jt]sx?$/.test(file)) return text;
  const ts = (await import("typescript")).default;
  const out = ts.transpileModule(text, {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, removeComments: true, jsx: ts.JsxEmit.Preserve },
  }).outputText;
  // A module of types alone emits `export {};`, which is no code.
  return out.replace(/^export \{\};$/gm, "").trim();
}

/**
 * What a fix commit's diff asks of the runner, before anything runs. Two
 * kinds of source change are not reverted, and are named instead:
 *   - `codeChanged: false`, its emitted code is the parent's: types, comments
 *     or a pure rename, which no test at run time can tell apart;
 *   - a deleted file: putting it back alone restores a module nothing imports
 *     any more (its callers changed in the same commit), so no test can see it.
 *
 * @param {{ subject: string; message: string; changes: Array<{ status: string; path: string; oldPath: string; codeChanged?: boolean }> }} commit
 * @returns {{ judged: false; why: string } | { judged: true; finding: string } | { judged: true; tests: string[]; sources: Array<{ path: string; oldPath: string; added: boolean }>; skipped: Array<{ path: string; why: string }> }}
 */
export function planFixCommit({ subject, message, changes }) {
  if (!FIX_SUBJECT.test(subject)) return { judged: false, why: "not a fix commit" };
  const sources = [];
  const skipped = [];
  const tests = [];
  for (const c of changes) {
    const kind = classifyPath(c.path);
    if (kind === "test") {
      if (!c.status.startsWith("D") && isRunnableTest(c.path)) tests.push(c.path);
    } else if (kind === "source" || (c.oldPath !== c.path && classifyPath(c.oldPath) === "source")) {
      if (c.status.startsWith("D")) skipped.push({ path: c.path, why: "deleted" });
      else if (c.codeChanged === false) skipped.push({ path: c.path, why: "emits the parent's code (types, comments or a rename only)" });
      else sources.push({ path: c.path, oldPath: c.oldPath, added: c.status.startsWith("A") || c.status.startsWith("C") });
    }
  }
  if (sources.length === 0) {
    const kinds = [...new Set(changes.map((c) => classifyPath(c.path)))].sort().join(", ") || "nothing";
    const named = skipped.map((s) => `${s.path} ${s.why}`).join("; ");
    return { judged: false, why: `exempt: no source file changes its code (${kinds}${named ? `; ${named}` : ""})` };
  }
  const trailer = UNGUARDED_TRAILER.exec(message);
  if (trailer) return { judged: false, why: `exempt: ${trailer[0]}` };
  if (tests.length === 0) {
    return {
      judged: true,
      finding: `changes ${sources.map((s) => s.path).join(", ")} and touches no test file vitest runs (src/ or tests/)`,
    };
  }
  return { judged: true, tests: tests.sort(), sources, skipped };
}

/* ---- running ------------------------------------------------------------ */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The environment a child vitest gets: no GIT_* (a hook's GIT_DIR would point
 * the worktree's git at another repository) and no VITEST* markers of a parent
 * run, except the CPU budget, which is never unset.
 */
export function childEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => !k.startsWith("GIT_") && (!k.startsWith("VITEST") || k === "VITEST_MAX_WORKERS")),
  );
}

/** One vitest run of `tests` in `dir`: true when every test passed. */
export function runVitest(dir, tests, { nodeModules = path.join(REPO, "node_modules"), timeoutMs = 600_000 } = {}) {
  const r = spawnSync(process.execPath, [path.join(nodeModules, "vitest", "vitest.mjs"), "run", ...tests], {
    cwd: dir,
    env: childEnv(),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`, status: r.status, signal: r.signal };
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    env: childEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/**
 * The commit's subject, message and changed files against its first parent;
 * each source change says whether its emitted code changed.
 */
export async function readCommit(repo, sha) {
  const message = git(repo, ["log", "-1", "--format=%B", sha]);
  const parent = tryGit(repo, ["rev-parse", "--verify", "--quiet", `${sha}^`])?.trim() || null;
  const changes = [];
  if (parent) {
    for (const row of git(repo, ["diff", "--name-status", "-M", parent, sha]).split("\n").filter(Boolean)) {
      const [status, first, second] = row.split("\t");
      const renamed = status.startsWith("R") || status.startsWith("C");
      const change = { status, oldPath: first, path: renamed ? second : first };
      if (classifyPath(change.path) === "source" || classifyPath(change.oldPath) === "source") {
        const before = status.startsWith("A") || status.startsWith("C") ? null : tryGit(repo, ["show", `${parent}:${change.oldPath}`]);
        const after = status.startsWith("D") ? null : tryGit(repo, ["show", `${sha}:${change.path}`]);
        change.codeChanged = (await emittedCode(before, change.oldPath)) !== (await emittedCode(after, change.path));
      }
      changes.push(change);
    }
  }
  return { sha, parent, subject: message.split("\n")[0], message, changes };
}

/** Put one source file back as the parent had it, in the worktree. */
function revertFile(dir, parent, source) {
  if (!source.added) {
    const before = git(dir, ["show", `${parent}:${source.oldPath}`]);
    fs.mkdirSync(path.dirname(path.join(dir, source.oldPath)), { recursive: true });
    fs.writeFileSync(path.join(dir, source.oldPath), before);
  }
  if (source.added || source.oldPath !== source.path) fs.rmSync(path.join(dir, source.path), { force: true });
}

function restoreTree(dir) {
  git(dir, ["checkout", "--force", "HEAD", "--", "."]);
  git(dir, ["clean", "-fdq", "--exclude=node_modules"]);
}

/**
 * The verdict for one commit: not judged (with why), or judged with the
 * findings and the seconds its runs took.
 *
 * @param {{ repo?: string; sha: string; run?: typeof runVitest; nodeModules?: string; log?: (line: string) => void }} options
 */
export async function judgeFixCommit({ repo = REPO, sha, run = runVitest, nodeModules = path.join(REPO, "node_modules"), log = () => {} }) {
  const commit = await readCommit(repo, sha);
  if (!commit.parent) return { sha, subject: commit.subject, judged: false, why: "root commit", findings: [], seconds: 0 };
  const plan = planFixCommit(commit);
  if (!plan.judged) return { sha, subject: commit.subject, judged: false, why: plan.why, findings: [], seconds: 0 };
  if ("finding" in plan) return { sha, subject: commit.subject, judged: true, findings: [plan.finding], seconds: 0 };
  for (const { path: file, why } of plan.skipped) log(`    ${file}: ${why}, not reverted`);

  const started = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-guarded-"));
  const findings = [];
  try {
    git(repo, ["worktree", "add", "--detach", "--quiet", dir, sha]);
    fs.symlinkSync(nodeModules, path.join(dir, "node_modules"), "junction");
    const baseline = run(dir, plan.tests, { nodeModules });
    if (!baseline.ok) {
      findings.push(`its tests (${plan.tests.join(", ")}) fail with the fix in place, so no revert can be judged`);
      log(baseline.output.slice(-2000));
    } else {
      for (const source of plan.sources) {
        revertFile(dir, commit.parent, source);
        const reverted = run(dir, plan.tests, { nodeModules });
        log(`    ${source.path} reverted: ${reverted.ok ? "tests stay green" : "tests turn red"}`);
        if (reverted.ok) {
          findings.push(`${source.path}: reverting it leaves ${plan.tests.join(", ")} green — no test the commit touched depends on it`);
        }
        restoreTree(dir);
      }
    }
  } finally {
    tryGit(repo, ["worktree", "remove", "--force", dir]);
    fs.rmSync(dir, { recursive: true, force: true });
    tryGit(repo, ["worktree", "prune"]);
  }
  return { sha, subject: commit.subject, judged: true, findings, seconds: Math.round((Date.now() - started) / 1000) };
}

/* ---- command line ------------------------------------------------------- */

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function isDirectExecution() {
  if (process.argv[1] === undefined) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  const repo = process.cwd();
  let shas;
  const list = argValue("--commits");
  if (list) shas = list.split(",").filter(Boolean);
  else {
    const head = argValue("--head") ?? "HEAD";
    let base = argValue("--base") ?? "origin/main";
    if (tryGit(repo, ["cat-file", "-e", `${base}^{commit}`]) === null) {
      const fallback = tryGit(repo, ["merge-base", head, "origin/main"])?.trim() || `${head}^`;
      console.log(`check-fix-guarded: base ${base} is not a commit here; using ${fallback}`);
      base = fallback;
    }
    shas = git(repo, ["rev-list", "--reverse", "--no-merges", `${base}..${head}`]).split("\n").filter(Boolean);
  }
  let fixes = 0;
  let failed = 0;
  let seconds = 0;
  for (const sha of shas) {
    const subject = git(repo, ["log", "-1", "--format=%s", sha]).trim();
    if (!FIX_SUBJECT.test(subject)) continue;
    fixes++;
    console.log(`  ${sha.slice(0, 8)} ${subject}`);
    const verdict = await judgeFixCommit({ repo, sha, log: (line) => console.log(line) });
    seconds += verdict.seconds;
    if (!verdict.judged) console.log(`    not judged: ${verdict.why}`);
    else if (verdict.findings.length === 0) console.log(`    guarded (${verdict.seconds}s)`);
    else {
      failed++;
      for (const f of verdict.findings) console.error(`    - ${f}`);
    }
  }
  console.log(`check-fix-guarded: ${shas.length} commit(s), ${fixes} fix commit(s), ${failed} unguarded, ${seconds}s of test runs`);
  if (failed > 0) {
    console.error(
      "A fix commit above has no test that fails without it. Write a test that turns red when the named\n" +
        "file is put back as it was, in a new commit (a pushed commit is not amended). When the fix truly\n" +
        "cannot be tested, say why in a line\n" +
        "  Fix-Unguarded: <why no test can tell the fixed code from the old>\n" +
        "of that commit's message. docs/contracts/fix-needs-a-red-test.md",
    );
    process.exitCode = 1;
  }
}
