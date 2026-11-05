#!/usr/bin/env node
/**
 * No commit bends a test to green without saying so.
 * Contract: docs/contracts/test-integrity.md, rule no-test-bent-to-green.
 *
 * A test that was made to pass instead of the code being made to work deletes
 * the only evidence that a behaviour broke, and every check after it stays
 * green. Each commit in the range is compared with its own parent, and it is
 * WEAKENED when it:
 *
 *   - removes test cases (`it(` / `test(`, any modifier) or assertions
 *     (`expect(` / `assert(`) from a test file, or deletes a test file;
 *   - adds a skip, todo, fails, only, skipIf/runIf, xit or xdescribe marker;
 *   - adds a commented-out test or assertion;
 *   - rewrites existing assertion lines while it changes no source file — the
 *     shape of "the test was wrong" (375b55d0 loosened `"not a git repository"`
 *     to "git said anything" after Windows CI failed twice; a commit that only
 *     touches tests and rewrites what they expect is that move, or a genuine
 *     test fix, and only its author can say which);
 *   - loosens a pinned ratchet: a BASELINE gaining a file or a count, a pinned
 *     exemption count rising, a pinned rule count falling, or a pin vanishing.
 *
 * A weakened commit passes only when its OWN message carries a line
 *
 *     Test-Weakened: <why, in a sentence>
 *
 * naming what the old assertion measured and why that was not the contract.
 * The check runs in CI over the pushed range and as a pre-push hook; both call
 * this file. It is a gate the change under review cannot edit in the same
 * breath: the vitest suite keeps its limits beside itself, this compares them
 * with the parent commit.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TRAILER = /^Test-Weakened:[ \t]*\S.{9,}$/m;

const TEST_PATH = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** Not source: a change here does not justify rewriting an assertion. */
const NOT_SOURCE = /(?:^docs\/|\.md$)/;
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;
/** `it(`, `test(`, `it.each([...])(`, `test.skipIf(cond)(` — one per case. */
const CASE = /(?<![\w$.])(?:it|test)(?:\.\w+(?:\((?:[^()]|\([^()]*\))*\))?)*\s*\(/g;
const ASSERTION = /(?<![\w$.])(?:expect|assert)(?:\.\w+)?\s*\(/g;
const SKIP = /(?<![\w$.])(?:it|test|describe|suite)\.(?:skip|todo|fails|only|skipIf|runIf)\b|(?<![\w$.])x(?:it|test|describe)\s*\(/g;
/**
 * A commented-out case (`// it("name"`, `// test.each(...)("name"`) or assertion
 * (`// expect(x)`). Code shapes only, not prose: "// it (Codex …) became" is a
 * sentence, so a case needs its name's opening quote and an assertion its paren.
 */
const COMMENTED_TEST =
  /^\s*(?:\/\/|\*|\/\*)\s*(?:(?:it|test|describe)(?:\.\w+(?:\([^)]*\))?)*\(\s*['"`]|(?:expect|assert)(?:\.\w+)?\()/;

export function isTestPath(path) {
  return TEST_PATH.test(path);
}

/** Counts in a test file's text. Comment lines count only as commented-out tests. */
export function measureTestText(text) {
  const m = { cases: 0, assertions: 0, skips: 0, commented: 0 };
  for (const line of text.split("\n")) {
    if (COMMENTED_TEST.test(line)) m.commented++;
    if (COMMENT_LINE.test(line)) continue;
    m.cases += (line.match(CASE) ?? []).length;
    m.assertions += (line.match(ASSERTION) ?? []).length;
    m.skips += (line.match(SKIP) ?? []).length;
  }
  return m;
}

/** Removed lines in a unified diff that held an assertion. */
export function removedAssertionLines(diffText) {
  let n = 0;
  for (const line of diffText.split("\n")) {
    if (!line.startsWith("-") || line.startsWith("---")) continue;
    const body = line.slice(1);
    if (!COMMENT_LINE.test(body) && new RegExp(ASSERTION.source).test(body)) n++;
  }
  return n;
}

/**
 * Every way a commit weakens its test files, as sentences.
 *
 * @param {{ files: Array<{ path: string; before: string | null; after: string | null; removedAssertions: number }>;
 *           sourceChanged: boolean }} input
 */
export function findWeakening({ files, sourceChanged }) {
  const found = [];
  for (const f of files) {
    const b = f.before === null ? null : measureTestText(f.before);
    const a = f.after === null ? null : measureTestText(f.after);
    if (b && !a) {
      if (b.cases > 0 || b.assertions > 0) found.push(`${f.path}: test file deleted (${b.cases} cases, ${b.assertions} assertions)`);
      continue;
    }
    if (!a) continue;
    const base = b ?? { cases: 0, assertions: 0, skips: 0, commented: 0 };
    if (a.cases < base.cases) found.push(`${f.path}: ${base.cases - a.cases} test case(s) removed`);
    if (a.assertions < base.assertions) found.push(`${f.path}: ${base.assertions - a.assertions} assertion(s) removed`);
    if (a.skips > base.skips) found.push(`${f.path}: ${a.skips - base.skips} skip/only/todo marker(s) added`);
    if (a.commented > base.commented) found.push(`${f.path}: ${a.commented - base.commented} commented-out test or assertion line(s) added`);
    if (b && !sourceChanged && f.removedAssertions > 0) {
      found.push(`${f.path}: ${f.removedAssertions} existing assertion line(s) rewritten in a commit that changes no source`);
    }
  }
  return found;
}

/**
 * Pinned ratchet numbers. `direction` says which way is LOOSER:
 * "up" — a higher number (or a new key) allows more; "down" — a lower one does.
 */
export const PINS = [
  { file: "src/path-containment-ratchet.test.ts", name: "BASELINE", shape: "record", direction: "up" },
  { file: "src/test-integrity.test.ts", name: "SKIP_BASELINE", shape: "record", direction: "up" },
  { file: "src/goals/gate-askers.test.ts", name: "PINNED_NONE", shape: "number", direction: "up" },
  { file: "src/contracts.test.ts", name: "PINNED", shape: "record", direction: "down" },
  { file: "src/file-size-ratchet.test.ts", name: "SIZE_BASELINE", shape: "record", direction: "up" },
];

/** A pin's value in a file's text: a number, a record, or null when absent. */
export function readPin(text, pin) {
  if (text === null) return null;
  if (pin.shape === "number") {
    const m = new RegExp(`const ${pin.name}\\s*(?::[^=]+)?=\\s*(\\d+)\\s*;`).exec(text);
    return m ? Number(m[1]) : null;
  }
  const m = new RegExp(`const ${pin.name}\\b[^=]*=\\s*\\{([\\s\\S]*?)\\}`).exec(text);
  if (!m) return null;
  const record = {};
  for (const [, key, value] of m[1].matchAll(/["']?([\w./-]+)["']?\s*:\s*(\d+)/g)) record[key] = Number(value);
  return record;
}

/** Every way `after` is looser than `before` for one pin, as sentences. */
export function pinLoosening(pin, before, after) {
  const where = `${pin.file} ${pin.name}`;
  if (before === null) return []; // a pin's first appearance tightens
  if (after === null) return [`${where} removed`];
  const looser = (from, to) => (pin.direction === "up" ? to > from : to < from);
  if (typeof before === "number") {
    return looser(before, after) ? [`${where} ${before} -> ${after}`] : [];
  }
  const found = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const from = before[key];
    const to = after[key];
    if (pin.direction === "up") {
      if (from === undefined) found.push(`${where} gained ${key} (${to})`);
      else if (to !== undefined && to > from) found.push(`${where} ${key} ${from} -> ${to}`);
    } else if (from !== undefined && (to === undefined || looser(from, to))) {
      found.push(`${where} ${key} ${from} -> ${to ?? "gone"}`);
    }
  }
  return found;
}

/**
 * The files that enforce the rules: this checker, the hooks and their installer,
 * the CI workflows, the contracts themselves, the checker of contracts, and the
 * repo-map doctor that keeps the map honest. docs/contracts/governance.md. A
 * commit that changes one says why, in a `Governance-Change:` line. In this
 * repository no person reviews a push, so the reason in the commit is the
 * review. The contracts' index (README.md) and the repo map's data
 * (docs/architecture/repo_map.yaml) are records, not rules: they change as the
 * code does, and are not governed.
 */
export const GOVERNED = [
  /^scripts\/ci\/check-test-integrity\.mjs$/,
  /^scripts\/git-hooks\//,
  /^scripts\/install-git-hooks\.mjs$/,
  /^\.github\/workflows\//,
  /^docs\/contracts\/(?!README\.md$)[^/]+\.md$/,
  /^src\/contracts\.test\.ts$/,
  /^scripts\/repo-map-doctor\.mjs$/,
];
export const GOVERNANCE_TRAILER = /^Governance-Change:[ \t]*\S.{9,}$/m;

export function governedChanges(paths) {
  return paths.filter((p) => GOVERNED.some((re) => re.test(p)));
}

/**
 * The verdict for one commit: what it weakened, which governed files it
 * changed, and the trailer lines that say why.
 *
 * @returns {{ findings: string[]; justification: string | null; governed: string[]; governanceReason: string | null }}
 */
export function judgeCommit({ message, files, sourceChanged, pins, changedPaths = [] }) {
  const findings = [
    ...findWeakening({ files, sourceChanged }),
    ...pins.flatMap(({ pin, before, after }) => pinLoosening(pin, before, after)),
  ];
  const m = TRAILER.exec(message);
  const g = GOVERNANCE_TRAILER.exec(message);
  return { findings, justification: m ? m[0] : null, governed: governedChanges(changedPaths), governanceReason: g ? g[0] : null };
}

/* ---- git wiring --------------------------------------------------------- */

const ZERO = /^0+$/;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function showAt(ref, file) {
  return tryGit(["show", `${ref}:${file}`]);
}

function isCommit(ref) {
  return ref && !ZERO.test(ref) && tryGit(["cat-file", "-e", `${ref}^{commit}`]) !== null;
}

/** Walk the base back over commits CI skipped (`[skip ci]`), except version bumps. */
function walkBackSkipped(base) {
  let cur = base;
  for (let i = 0; i < 50; i++) {
    const msg = tryGit(["log", "-1", "--format=%B", cur]);
    if (msg === null || !msg.includes("[skip ci]") || /^chore: bump version/.test(msg)) return cur;
    const parent = tryGit(["rev-parse", `${cur}^`]);
    if (parent === null) return cur;
    cur = parent.trim();
  }
  return cur;
}

function commitInput(sha) {
  const parent = tryGit(["rev-parse", `${sha}^`])?.trim();
  if (!parent) return null; // the root commit has nothing to weaken
  const message = git(["log", "-1", "--format=%B", sha]);
  const status = git(["diff", "--name-status", "-M", parent, sha]).trim();
  const files = [];
  const changedPaths = [];
  let sourceChanged = false;
  for (const row of status ? status.split("\n") : []) {
    const [code, first, second] = row.split("\t");
    const oldPath = first;
    const newPath = code.startsWith("R") || code.startsWith("C") ? second : first;
    changedPaths.push(newPath);
    if (newPath !== oldPath) changedPaths.push(oldPath);
    const testFile = isTestPath(newPath) || isTestPath(oldPath);
    if (!testFile) {
      if (!NOT_SOURCE.test(newPath)) sourceChanged = true;
      continue;
    }
    const before = code.startsWith("A") || code.startsWith("C") ? null : showAt(parent, oldPath);
    const after = code.startsWith("D") ? null : showAt(sha, newPath);
    const diff = before && after ? git(["diff", "--unified=0", "-M", parent, sha, "--", oldPath, newPath]) : "";
    files.push({ path: newPath, before, after, removedAssertions: removedAssertionLines(diff) });
  }
  const pins = PINS.map((pin) => ({ pin, before: readPin(showAt(parent, pin.file), pin), after: readPin(showAt(sha, pin.file), pin) }));
  return { message, files, sourceChanged, pins, changedPaths };
}

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

function isDirectExecution() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  const head = argValue("--head", "HEAD");
  let base = argValue("--base", "origin/main");
  if (!isCommit(base)) {
    const fallback = tryGit(["merge-base", head, "origin/main"])?.trim() || tryGit(["rev-parse", `${head}^`])?.trim();
    console.log(`check-test-integrity: base ${base || "(none)"} is not a commit here; using ${fallback}`);
    base = fallback;
  }
  if (process.argv.includes("--walk-back-skip-ci")) base = walkBackSkipped(base);
  const shas = git(["rev-list", "--reverse", "--no-merges", `${base}..${head}`]).split("\n").filter(Boolean);
  let failed = 0;
  let justified = 0;
  let ungoverned = 0;
  let governedCount = 0;
  for (const sha of shas) {
    const input = commitInput(sha);
    if (!input) continue;
    const { findings, justification, governed, governanceReason } = judgeCommit(input);
    const subject = input.message.split("\n")[0];
    if (findings.length > 0) {
      const list = findings.map((f) => `    - ${f}`).join("\n");
      if (justification) {
        justified++;
        console.log(`  ${sha.slice(0, 8)} ${subject}\n${list}\n    justified: ${justification}`);
      } else {
        failed++;
        console.error(`  ${sha.slice(0, 8)} ${subject}\n${list}`);
      }
    }
    if (governed.length > 0) {
      governedCount++;
      const list = governed.map((f) => `    - governed file changed: ${f}`).join("\n");
      if (governanceReason) console.log(`  ${sha.slice(0, 8)} ${subject}\n${list}\n    explained: ${governanceReason}`);
      else {
        ungoverned++;
        console.error(`  ${sha.slice(0, 8)} ${subject}\n${list}`);
      }
    }
  }
  console.log(
    `check-test-integrity: ${shas.length} commit(s) checked, ${failed + justified} weakened (${justified} justified), ` +
      `${governedCount} changed a governed file (${governedCount - ungoverned} explained)`,
  );
  if (ungoverned > 0) {
    console.error(
      "A commit above changes a file that enforces the rules without saying why. Add a line\n" +
        "  Governance-Change: <what rule changes, and why the old one was wrong or incomplete>\n" +
        "to that commit's message. docs/contracts/governance.md",
    );
    process.exitCode = 1;
  }
  if (failed > 0) {
    console.error(
      "A commit above weakens a test without saying why. Make the code pass the test, or — when the\n" +
        "test itself was wrong — say so in that commit's message with a line\n" +
        "  Test-Weakened: <what the old assertion measured, and why that was not the contract>\n" +
        "(a pushed commit is not amended: revert and recommit, or follow up). docs/contracts/test-integrity.md",
    );
    process.exitCode = 1;
  }
}
