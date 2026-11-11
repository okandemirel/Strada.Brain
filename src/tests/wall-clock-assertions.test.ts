/**
 * Detector for docs/contracts/wall-clock-assertions.md.
 *
 * Rule no-new-wall-clock-bound. A test that asserts how little wall-clock time
 * something took, `expect(Date.now() - started).toBeLessThan(500)`, measures
 * the machine as much as the code. Several agents share this machine and its
 * load average passes 100; such a bound then turns red on a change that has
 * nothing to do with it. The repository already holds the bounds counted in
 * WALL_CLOCK_BASELINE, file by file: this is a RATCHET. No file may gain one,
 * and a file whose count drops lowers its line here in the same change, so the
 * number only goes down. Raising a line is a loosened pin for
 * scripts/ci/check-test-integrity.mjs and needs a Test-Weakened line.
 *
 * What counts, worked out with the TypeScript parser and its name resolution,
 * not by line: an `expect(x)` or `expect.soft(x)`, with or without a message,
 * ending in `.toBeLessThan(…)`, `.toBeLessThanOrEqual(…)`,
 * `.not.toBeGreaterThan(…)` or `.not.toBeGreaterThanOrEqual(…)`, where `x` is
 * an elapsed time: a clock read minus anything (`Date.now() - t`,
 * `performance.now() - t`, `end - t` with `const end = Date.now()`), or a
 * stamp minus a name holding an earlier clock read (`cooldownUntil - before`);
 * also as the value of a name (`const elapsed = Date.now() - t`), of a
 * destructured or object property (`const { ms } = await timed(…)`, `run.ms`),
 * of what a function the file declares returns, or inside Math.abs/round/….
 * The clock is the global `Date` or `performance`, or `performance` imported
 * from node:perf_hooks under any name. The time left until a deadline
 * (`deadline - Date.now()`) is not an elapsed time: load can only shrink it.
 * The contract lists what this sees in full and what it cannot see.
 *
 * Rule repo-scan-carries-its-limit. A test of a gates detector
 * (scripts/ci/gates.mjs DETECTORS) that walks a directory inside its body
 * carries its own limit, because vitest fails a test that outlasts its limit
 * even after it passes, and the 30 s default turns a busy machine into a red
 * detector. A walk is a call of readdirSync, readdir, opendir(Sync), glob(Sync),
 * the shared testFiles lister, or `git ls-files`/`git grep`, reached from the
 * test body directly or through functions the file declares. A walk reached
 * through a call whose argument is a temp folder (mkdtemp, tmpdir) is not a
 * repository walk.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SELF = "src/tests/wall-clock-assertions.test.ts";
const { testFiles } = (await import(pathToFileURL(path.join(REPO, "scripts", "ci", "dist-build.mjs")).href)) as {
  testFiles(root: string): string[];
};

/**
 * Wall-clock upper bounds per test file, as this detector sees them. Measured
 * on main at 78500e4b (2026-11-11): 60 in 41 files. Lower a count when you
 * replace a bound with fake timers or a counted event; delete its line at
 * zero. Never raise one, never add one.
 */
const WALL_CLOCK_BASELINE: Readonly<Record<string, number>> = {
  "src/agents/memory-refresher.test.ts": 1,
  "src/agents/multi/delegation/delegation-manager.test.ts": 1,
  "src/agents/orchestrator-provider-failover.test.ts": 1,
  "src/agents/providers/claude-seat-review.test.ts": 1,
  "src/agents/providers/fallback-chain.test.ts": 2,
  "src/agents/providers/first-response-budget.test.ts": 1,
  "src/agents/providers/provider-features.test.ts": 1,
  "src/agents/review/codex-second-opinion.test.ts": 1,
  "src/agents/tools/search-glob-cost.test.ts": 4,
  "src/agents/tools/search-regex-timeout.test.ts": 2,
  "src/bench/bounded-command.test.ts": 1,
  "src/campaign/campaign-intake.test.ts": 2,
  "src/campaign/campaign-manager-dispose.test.ts": 1,
  "src/channels/discord/rate-limiter.test.ts": 3,
  "src/channels/slack/__tests__/rate-limiter.test.ts": 1,
  "src/common/fetch-with-retry.test.ts": 2,
  "src/common/project-write-lock.test.ts": 1,
  "src/core/runtime-lock.test.ts": 1,
  "src/core/status-report.test.ts": 1,
  "src/daemon/deployment/bounded-process.test.ts": 3,
  "src/intelligence/csharp-parser.test.ts": 2,
  "src/learning/chains/chain-detector.test.ts": 1,
  "src/learning/chains/chain-parallel.test.ts": 1,
  "src/learning/matching/pattern-matcher-bounds.test.ts": 2,
  "src/learning/pipeline/learning-queue-bounds.test.ts": 1,
  "src/learning/pipeline/learning-queue.test.ts": 1,
  "src/rag/file-pattern.test.ts": 2,
  "src/rag/hnsw/hnsw-integration.test.ts": 1,
  "src/rag/hnsw/hnsw-performance.test.ts": 3,
  "src/rag/hnsw/hnsw-vector-store.test.ts": 1,
  "src/skills/bundled/file-utils/file-utils.test.ts": 1,
  "src/skills/bundled/web-search/web-search.test.ts": 1,
  "src/skills/project-files.test.ts": 1,
  "src/skills/skill-import-scan.test.ts": 1,
  "src/supervisor/__tests__/supervisor-dispatcher.test.ts": 2,
  "src/tasks/task-manager.test.ts": 1,
  "src/utils/process-runner.test.ts": 3,
  "src/vault/canvas-generator.test.ts": 1,
  "src/vault/glob-match.test.ts": 1,
  "src/vault/unity-project-vault.test.ts": 1,
  "tests/vault/phase2.acceptance.test.ts": 1,
};

/** The limit a test that scans the repository carries, as clean-checkout.test.ts and dist-readers.test.ts do. */
const REPO_SCAN_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Rule no-new-wall-clock-bound
// ---------------------------------------------------------------------------

const UPPER = new Set(["toBeLessThan", "toBeLessThanOrEqual"]);
const UPPER_NEGATED = new Set(["toBeGreaterThan", "toBeGreaterThanOrEqual"]);
const PERF_HOOKS = new Set(["perf_hooks", "node:perf_hooks"]);

/** A wall-clock upper bound: where it is and how it reads. */
interface Bound {
  file: string;
  line: number;
  text: string;
  form: string;
}

/** Parens, `as`, `!` and `satisfies` change nothing about the value. */
function strip(node: ts.Expression): ts.Expression {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isTypeAssertionExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

/** One program over every file, so a name resolves to its declaration in its own scope. */
function program(files: Map<string, string>): ts.TypeChecker & { sourceOf(file: string): ts.SourceFile } {
  const sources = new Map<string, ts.SourceFile>();
  for (const [file, text] of files) {
    sources.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  }
  const host: ts.CompilerHost = {
    getSourceFile: (name) => sources.get(path.resolve(name)),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => REPO,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => sources.has(path.resolve(name)),
    readFile: () => undefined,
  };
  const checker = ts.createProgram([...sources.keys()], { noLib: true, noResolve: true, types: [] }, host).getTypeChecker();
  return Object.assign(checker, { sourceOf: (file: string) => sources.get(file)! });
}

function declarationOf(checker: ts.TypeChecker, id: ts.Identifier): ts.Declaration | undefined {
  return checker.getSymbolAtLocation(id)?.declarations?.[0];
}

/** `performance`, global or imported from node:perf_hooks under any name, or `ns.performance` of that module. */
function isPerformance(checker: ts.TypeChecker, node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) {
    const decl = declarationOf(checker, node);
    if (!decl) return node.text === "performance";
    if (!ts.isImportSpecifier(decl)) return false;
    const imported = (decl.propertyName ?? decl.name).text;
    const from = decl.parent.parent.parent.moduleSpecifier;
    return imported === "performance" && ts.isStringLiteral(from) && PERF_HOOKS.has(from.text);
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === "performance" && ts.isIdentifier(node.expression)) {
    const decl = declarationOf(checker, node.expression);
    const clause = decl && (ts.isNamespaceImport(decl) ? decl.parent : ts.isImportClause(decl) ? decl : undefined);
    const from = clause?.parent.moduleSpecifier;
    return from !== undefined && ts.isStringLiteral(from) && PERF_HOOKS.has(from.text);
  }
  return false;
}

/** Math functions that keep an elapsed time an elapsed time: `Math.abs(Date.now() - t)`. */
const KEEPS_ELAPSED = new Set(["abs", "round", "floor", "ceil", "trunc"]);

/** What a `return` of a function the file declares hands back: `timed(x)` with `const timed = (…) => { …; return Date.now() - t; }`. */
function returnsOf(checker: ts.TypeChecker, callee: ts.Expression): ts.Expression[] {
  if (!ts.isIdentifier(callee)) return [];
  const decl = declarationOf(checker, callee);
  let fn: ts.FunctionLikeDeclaration | undefined;
  if (decl && ts.isFunctionDeclaration(decl)) fn = decl;
  else if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = strip(decl.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) fn = init;
  }
  if (!fn?.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n)) return; // a nested function's return is not this one's
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn.body, visit);
  return out;
}

/** The value of property `name` in an object literal: `{ ms }` or `{ ms: … }`. */
function propertyValue(checker: ts.TypeChecker, obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (!p.name || !ts.isIdentifier(p.name) || p.name.text !== name) continue;
    if (ts.isPropertyAssignment(p)) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p)) {
      const decl = checker.getShorthandAssignmentValueSymbol(p)?.declarations?.[0];
      if (decl && ts.isVariableDeclaration(decl)) return decl.initializer;
    }
  }
  return undefined;
}

/**
 * Works out what the expressions of one program stand for. Each answer is
 * kept per node, and a node already being worked out stands for itself, so a
 * name declared in terms of itself ends.
 */
function valueReader(checker: ts.TypeChecker) {
  const values = new Map<ts.Node, ts.Expression[]>();
  const forms = new Map<ts.Node, string | undefined>();

  /** Property `key` of what `holder` stands for, where that is an object literal. */
  const member = (holder: ts.Expression, key: string): ts.Expression[] =>
    valuesOf(holder).flatMap((h) => {
      const value = ts.isObjectLiteralExpression(h) ? propertyValue(checker, h, key) : undefined;
      return value ? valuesOf(value) : [];
    });

  /**
   * The values an expression stands for: itself, through `await`; the `const`
   * a name was declared with, also by object destructuring
   * (`const { ms } = await timed(…)`); what a function the file declares
   * returns; and a property of an object literal any of these is.
   */
  function valuesOf(node: ts.Expression): ts.Expression[] {
    const n = strip(node);
    const known = values.get(n);
    if (known) return known;
    values.set(n, [n]);
    let out: ts.Expression[] = [];
    if (ts.isAwaitExpression(n)) out = valuesOf(n.expression);
    else if (ts.isIdentifier(n)) {
      const decl = declarationOf(checker, n);
      if (decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.initializer) out = valuesOf(decl.initializer);
      else if (decl && ts.isBindingElement(decl) && !decl.dotDotDotToken && ts.isObjectBindingPattern(decl.parent)) {
        const holder = decl.parent.parent;
        const key = decl.propertyName ?? decl.name;
        if (ts.isVariableDeclaration(holder) && holder.initializer && ts.isIdentifier(key)) out = member(holder.initializer, key.text);
      }
    } else if (ts.isCallExpression(n)) out = returnsOf(checker, n.expression).flatMap(valuesOf);
    else if (ts.isPropertyAccessExpression(n)) out = member(n.expression, n.name.text);
    if (out.length === 0) out = [n];
    values.set(n, out);
    return out;
  }

  /** `Date.now()` on the global Date or `performance.now()`, written out at this spot. */
  const isNowCall = (n: ts.Expression): boolean => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== "now") return false;
    const clock = strip(n.expression.expression);
    if (ts.isIdentifier(clock) && clock.text === "Date") return declarationOf(checker, clock) === undefined;
    return isPerformance(checker, clock);
  };

  /** A clock read, as it is or as what the expression stands for. */
  const isClockRead = (node: ts.Expression): boolean => valuesOf(node).some(isNowCall);

  /**
   * Which form of elapsed time an expression is, or undefined:
   * - "clock minus": a clock read minus anything (`Date.now() - t`, `end - t`, `Date.now() - a - b`);
   * - "stamp minus start": anything minus a name that holds an earlier clock read, or one
   *   minus anything (`entry.cooldownUntil - before`, `call.since - expectedSince` with
   *   `const expectedSince = now - 30 * DAY`), which grows with every millisecond the code under test took;
   * - and either of them as what a name, a call or a property stands for (above),
   *   or wrapped in Math.abs/round/floor/ceil/trunc.
   * A clock read written out on the right (`deadline - Date.now()`) is the time left, which load only shrinks.
   */
  function elapsedForm(node: ts.Expression): string | undefined {
    const n = strip(node);
    if (forms.has(n)) return forms.get(n);
    forms.set(n, undefined);
    let form: string | undefined;
    for (const v of valuesOf(n)) {
      if (ts.isBinaryExpression(v) && v.operatorToken.kind === ts.SyntaxKind.MinusToken) {
        if (isClockRead(v.left) || elapsedForm(v.left) === "clock minus") form = "clock minus";
        else if (ts.isIdentifier(strip(v.right)) && (isClockRead(v.right) || elapsedForm(v.right) === "clock minus")) {
          form = "stamp minus start";
        }
      } else if (ts.isCallExpression(v) && ts.isPropertyAccessExpression(v.expression) && v.arguments[0]) {
        const { expression: math, name } = v.expression;
        if (ts.isIdentifier(math) && math.text === "Math" && KEEPS_ELAPSED.has(name.text)) form = elapsedForm(v.arguments[0]);
      }
      if (form) break;
    }
    forms.set(n, form);
    return form;
  }

  return { elapsedForm };
}

/** `expect(x, msg?)` or `expect.soft(x, msg?)` at the root of a matcher chain, and whether `.not` is on it. */
function expectTarget(call: ts.CallExpression): { target: ts.Expression; matcher: string; negated: boolean } | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const matcher = call.expression.name.text;
  let negated = false;
  let obj = call.expression.expression;
  while (ts.isPropertyAccessExpression(obj)) {
    if (obj.name.text === "not") negated = !negated;
    else return undefined;
    obj = obj.expression;
  }
  if (!ts.isCallExpression(obj) || obj.arguments.length === 0) return undefined;
  const head = obj.expression;
  const isExpect =
    (ts.isIdentifier(head) && head.text === "expect") ||
    (ts.isPropertyAccessExpression(head) && head.name.text === "soft" && ts.isIdentifier(head.expression) && head.expression.text === "expect");
  return isExpect ? { target: obj.arguments[0]!, matcher, negated } : undefined;
}

/**
 * Every wall-clock upper bound in the test files of `root` (repo-relative names).
 * A file that never spells `now` and an upper matcher has no clock read for the
 * parse to find, so only the others are parsed.
 */
function wallClockBounds(root: string, rels: readonly string[]): Bound[] {
  const texts = new Map<string, string>();
  const relOf = new Map<string, string>();
  for (const rel of rels) {
    const file = path.resolve(root, rel);
    const text = readFileSync(file, "utf8");
    if (!/\bnow\b/.test(text) || !/\b(?:toBeLessThan|toBeGreaterThan)/.test(text)) continue;
    texts.set(file, text);
    relOf.set(file, rel);
  }
  const checker = program(texts);
  const { elapsedForm } = valueReader(checker);
  const found: Bound[] = [];
  for (const file of texts.keys()) {
    const sf = checker.sourceOf(file);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const e = expectTarget(node);
        const upper = e && (e.negated ? UPPER_NEGATED.has(e.matcher) : UPPER.has(e.matcher));
        const form = e && upper ? elapsedForm(e.target) : undefined;
        if (e && form) {
          found.push({
            file: relOf.get(file)!,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            text: node.getText(sf).replace(/\s+/g, " "),
            form,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

function countByFile(bounds: readonly Bound[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const b of bounds) counts[b.file] = (counts[b.file] ?? 0) + 1;
  return counts;
}

/** What the ratchet says about a measurement: bounds over the baseline, and baseline lines left too high. */
function judgeBounds(bounds: readonly Bound[], baseline: Readonly<Record<string, number>>): { added: string[]; stale: string[] } {
  const counts = countByFile(bounds);
  const added: string[] = [];
  for (const [file, n] of Object.entries(counts)) {
    const allowed = baseline[file] ?? 0;
    if (n <= allowed) continue;
    const here = bounds.filter((b) => b.file === file).map((b) => `  ${b.file}:${b.line}  ${b.text}`);
    added.push(`${file}: ${n} wall-clock upper bound(s), baseline ${allowed}\n${here.join("\n")}`);
  }
  const stale = Object.entries(baseline)
    .filter(([file, n]) => (counts[file] ?? 0) < n)
    .map(([file, n]) => `${file}: baseline ${n}, now ${counts[file] ?? 0}`);
  return { added, stale };
}

const NEW_BOUND_ADVICE =
  "A test gained an upper bound on wall-clock time (docs/contracts/wall-clock-assertions.md). On a machine " +
  "several agents share, such a bound turns red on unrelated changes. Assert the behaviour instead of the " +
  "machine's speed: fake timers (vi.useFakeTimers / vi.advanceTimersByTime), an injected clock, a counted " +
  "call or attempt, or the order of events. Do not move the bound into a helper or a property to hide it; " +
  "raising WALL_CLOCK_BASELINE is a loosened pin and needs a Test-Weakened line.";

// ---------------------------------------------------------------------------
// Rule repo-scan-carries-its-limit
// ---------------------------------------------------------------------------

const WALKS = new Set(["readdirSync", "readdir", "opendirSync", "opendir", "globSync", "glob", "testFiles"]);
const CHILD = new Set(["execFileSync", "execFile", "execSync", "exec", "spawnSync", "spawn"]);
const TEMP = new Set(["mkdtempSync", "mkdtemp", "tmpdir"]);

/** The test files gates.mjs runs as contract detectors, read from its DETECTORS array literal. */
function gateDetectors(gatesSource: string): string[] {
  const sf = ts.createSourceFile("gates.mjs", gatesSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "DETECTORS" && node.initializer) {
      const init = node.initializer;
      if (ts.isArrayLiteralExpression(init)) for (const el of init.elements) if (ts.isStringLiteral(el)) out.push(el.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

/** A test case (`it`/`test`, also `.each(…)`, `.concurrent`, …) and the head it was called through. */
function caseHead(call: ts.CallExpression): string | undefined {
  let e: ts.Expression = call.expression;
  while (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e)) e = ts.isCallExpression(e) ? e.expression : e.expression;
  return ts.isIdentifier(e) ? e.text : undefined;
}

/** A third argument, or an options object holding `timeout`, among a test's or describe's arguments. */
function carriesLimit(call: ts.CallExpression): boolean {
  const fnAt = call.arguments.findIndex((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
  return call.arguments.some((a, i) => {
    if (ts.isObjectLiteralExpression(a)) {
      return a.properties.some((p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === "timeout");
    }
    return fnAt !== -1 && i > fnAt;
  });
}

/** Which test cases of one file walk a directory in their body, and whether each carries a limit. */
function scanningCases(rel: string, source: string): { line: number; title: string; via: string; limited: boolean }[] {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = new Map<string, ts.Node>();
  const consts = new Map<string, ts.Expression>();
  const collect = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) functions.set(n.name.text, n.body);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = n.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) functions.set(n.name.text, init.body);
      else consts.set(n.name.text, init);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);

  /** A temp folder: made by mkdtemp or under tmpdir, directly, through a const, or by a function the file declares. */
  const isTemp = (node: ts.Node, seen: Set<string>): boolean => {
    let hit = false;
    const v = (n: ts.Node): void => {
      if (hit) return;
      if (ts.isCallExpression(n)) {
        const name = calleeName(n.expression);
        if (name && TEMP.has(name)) return void (hit = true);
        if (name && functions.has(name) && !seen.has(name)) {
          seen.add(name);
          if (isTemp(functions.get(name)!, seen)) return void (hit = true);
        }
      }
      if (ts.isIdentifier(n) && consts.has(n.text) && !seen.has(n.text)) {
        seen.add(n.text);
        if (isTemp(consts.get(n.text)!, seen)) return void (hit = true);
      }
      ts.forEachChild(n, v);
    };
    v(node);
    return hit;
  };

  /** The walk a body reaches, as a chain of names, or undefined. */
  const reaches = (body: ts.Node, seen: Set<string>): string | undefined => {
    let hit: string | undefined;
    const v = (n: ts.Node): void => {
      if (hit) return;
      if (ts.isCallExpression(n)) {
        const name = calleeName(n.expression);
        const temp = n.arguments.some((a) => isTemp(a, new Set()));
        if (name && WALKS.has(name) && !temp) return void (hit = name);
        if (name && CHILD.has(name) && n.arguments.some((a) => /["'`](?:ls-files|grep)["'`]/.test(a.getText(sf)))) {
          return void (hit = `git ${name}`);
        }
        if (name && functions.has(name) && !seen.has(name) && !temp) {
          seen.add(name);
          const deeper = reaches(functions.get(name)!, seen);
          if (deeper) return void (hit = `${name} > ${deeper}`);
        }
      }
      ts.forEachChild(n, v);
    };
    v(body);
    return hit;
  };

  const out: { line: number; title: string; via: string; limited: boolean }[] = [];
  const visit = (node: ts.Node, describeLimited: boolean): void => {
    if (ts.isCallExpression(node)) {
      const head = caseHead(node);
      if (head === "describe") {
        const limited = describeLimited || carriesLimit(node);
        for (const a of node.arguments) visit(a, limited);
        return;
      }
      if (head === "it" || head === "test") {
        const fn = node.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
        const via = fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? reaches(fn.body, new Set()) : undefined;
        if (via) {
          out.push({
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            title: node.arguments[0] ? node.arguments[0].getText(sf).slice(0, 90) : "",
            via,
            limited: describeLimited || carriesLimit(node),
          });
        }
        return;
      }
    }
    ts.forEachChild(node, (c) => visit(c, describeLimited));
  };
  visit(sf, false);
  return out;
}

function unlimitedScans(root: string, detectors: readonly string[]): string[] {
  return detectors.flatMap((rel) =>
    scanningCases(rel, readFileSync(path.join(root, rel), "utf8"))
      .filter((c) => !c.limited)
      .map((c) => `${rel}:${c.line} ${c.title} walks the tree (${c.via}) with no limit of its own`),
  );
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

let repoBounds: Bound[] | undefined;
/** The repository's own measurement, made once for the tests that read it. */
const measureRepo = (): Bound[] => (repoBounds ??= wallClockBounds(REPO, testFiles(REPO)));

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureRoot(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "strada-wall-clock-"));
  temps.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body, "utf8");
  }
  return root;
}

describe("wall-clock upper bounds in tests only go down (docs/contracts/wall-clock-assertions.md)", () => {
  it("no test file gained a wall-clock upper bound", () => {
    const { added } = judgeBounds(measureRepo(), WALL_CLOCK_BASELINE);
    expect(added, NEW_BOUND_ADVICE).toEqual([]);
  }, REPO_SCAN_TIMEOUT_MS);

  it("the baseline is lowered as soon as a bound goes away", () => {
    const { stale } = judgeBounds(measureRepo(), WALL_CLOCK_BASELINE);
    expect(stale, `lower these lines in WALL_CLOCK_BASELINE in ${SELF} (delete at zero) so the ratchet holds`).toEqual([]);
  }, REPO_SCAN_TIMEOUT_MS);

  it("counts every form the contract says it sees", () => {
    const root = fixtureRoot({
      "src/seen.test.ts": [
        'import { performance as perf } from "node:perf_hooks";',
        'import * as hooks from "node:perf_hooks";',
        "const t = Date.now();",
        "expect(Date.now() - t).toBeLessThan(500);",
        'expect(Date.now() - t, "late").toBeLessThanOrEqual(500);',
        "expect(performance.now() - t).toBeLessThan(500);",
        "expect(perf.now() - t).toBeLessThan(500);",
        "expect(hooks.performance.now() - t).toBeLessThan(500);",
        "const elapsed = Date.now() - t;",
        "expect(elapsed).toBeLessThan(500);",
        "const end = performance.now();",
        "expect(end - t).not.toBeGreaterThan(500);",
        "let took = (Date.now() - t) as number;",
        "expect.soft(took).not.toBeGreaterThanOrEqual(500);",
        "function inner() { const ms = performance.now() - t; expect(ms!).toBeLessThan(500); }",
        "expect(Math.abs(Date.now() - DAY - since)).toBeLessThan(500);",
        "expect(entry.cooldownUntil - t).toBeLessThanOrEqual(500);",
        "const expectedSince = t - DAY;",
        "expect(Math.round(call.since - expectedSince)).toBeLessThan(500);",
        "const timed = (run: () => void): number => { const s = performance.now(); run(); return performance.now() - s; };",
        "expect(timed(work)).toBeLessThan(500);",
        "async function measured() { const s = Date.now(); await work(); return { result: 1, ms: Date.now() - s }; }",
        "const { ms } = await measured();",
        "expect(ms).toBeLessThan(500);",
        "const run = await measured();",
        "expect(run.ms).toBeLessThan(500);",
        "function bench() { const insertMs = Date.now() - t; return { insertMs }; }",
        "expect(bench().insertMs).toBeLessThan(500);",
      ].join("\n"),
    });
    const bounds = wallClockBounds(root, testFiles(root));
    expect(bounds.map((b) => `${b.line} ${b.form}`)).toEqual([
      "4 clock minus",
      "5 clock minus",
      "6 clock minus",
      "7 clock minus",
      "8 clock minus",
      "10 clock minus",
      "12 clock minus",
      "14 clock minus",
      "15 clock minus",
      "16 clock minus",
      "17 stamp minus start",
      "19 stamp minus start",
      "21 clock minus",
      "24 clock minus",
      "26 clock minus",
      "28 clock minus",
    ]);
  });

  it("does not count lower bounds, time left to a deadline, other numbers or a clock that is not the global one", () => {
    const root = fixtureRoot({
      "src/unseen.test.ts": [
        "const t = 1_000;",
        "expect(Date.now() - t).toBeGreaterThanOrEqual(300);",
        "expect(Date.now() - t).not.toBeLessThan(300);",
        "expect(deadline - Date.now()).toBeLessThan(60_000);",
        "expect(deadline - (Date.now() - 5)).toBeLessThan(60_000);",
        "const left = deadline - Date.now();",
        "expect(left).toBeLessThan(60_000);",
        "expect(rows.length - 1).toBeLessThan(5);",
        "const now = () => 5;",
        "function f(Date: { now(): number }) { expect(Date.now() - t).toBeLessThan(5); }",
        'import { performance } from "./fake-clock.js";',
        "expect(performance.now() - t).toBeLessThan(5);",
      ].join("\n"),
    });
    expect(wallClockBounds(root, testFiles(root))).toEqual([]);
  });

  it("turns red on a new expect(Date.now() - t).toBeLessThan(500), and green once the baseline holds it", () => {
    const root = fixtureRoot({
      "src/fresh.test.ts": "const t = Date.now();\nawait work();\nexpect(Date.now() - t).toBeLessThan(500);\n",
      "src/kept.test.ts": "const t = Date.now();\nconst elapsed = Date.now() - t;\nexpect(elapsed).toBeLessThan(900);\n",
    });
    const bounds = wallClockBounds(root, testFiles(root));
    const kept = { "src/kept.test.ts": 1 };
    expect(judgeBounds(bounds, kept).added).toEqual([
      "src/fresh.test.ts: 1 wall-clock upper bound(s), baseline 0\n  src/fresh.test.ts:3  expect(Date.now() - t).toBeLessThan(500)",
    ]);
    expect(judgeBounds(bounds, { ...kept, "src/fresh.test.ts": 1 })).toEqual({ added: [], stale: [] });
    expect(judgeBounds(bounds, { ...kept, "src/fresh.test.ts": 1, "src/gone.test.ts": 2 }).stale).toEqual([
      "src/gone.test.ts: baseline 2, now 0",
    ]);
  });
});

describe("a gates detector that walks the repository carries its own limit (docs/contracts/wall-clock-assertions.md)", () => {
  const gates = readFileSync(path.join(REPO, "scripts", "ci", "gates.mjs"), "utf8");

  it("gates.mjs runs this detector", () => {
    expect(gateDetectors(gates)).toContain(SELF);
  });

  it("every test of a gates detector that walks the tree in its body carries a limit", () => {
    const found = unlimitedScans(REPO, gateDetectors(gates));
    expect(
      found,
      "vitest fails a test that outlasts its limit even after it passes; a walk of the repository on a loaded " +
        "machine can outlast the 30 s default. Give the test its own limit, as REPO_SCAN_TIMEOUT_MS here does.",
    ).toEqual([]);
  }, REPO_SCAN_TIMEOUT_MS);

  it("names a walk with no limit, directly or through the file's own functions, and passes the ones that carry one", () => {
    const root = fixtureRoot({
      "src/d.test.ts": [
        'import { readdirSync, mkdtempSync } from "node:fs";',
        'import { execFileSync } from "node:child_process";',
        "function walk(dir: string) { return readdirSync(dir); }",
        "const lister = () => walk(ROOT);",
        'it("bare", () => { readdirSync("src"); });',
        'it("helper", () => { lister(); });',
        'it("git", () => { execFileSync("git", ["ls-files"]); });',
        'it("lister", () => { dist.testFiles(ROOT); });',
        'it("number", () => { walk(ROOT); }, 120_000);',
        'it("named", () => { walk(ROOT); }, LIMIT);',
        'it("options", { timeout: 60_000 }, () => { walk(ROOT); });',
        'describe("group", () => { it("under limit", () => { walk(ROOT); }); }, { timeout: 60_000 });',
        'describe("plain", () => { it("under none", () => { walk(ROOT); }); });',
        'it("temp", () => { walk(mkdtempSync("x-")); });',
        "const tmp = () => mkdtempSync('y-');",
        'it("temp via helper", () => { const r = tmp(); walk(r); });',
        'it("no walk", () => { expect(1).toBe(1); });',
      ].join("\n"),
    });
    const cases = scanningCases("src/d.test.ts", readFileSync(path.join(root, "src/d.test.ts"), "utf8"));
    expect(cases.filter((c) => !c.limited).map((c) => `${c.line} ${c.via}`)).toEqual([
      "5 readdirSync",
      "6 lister > walk > readdirSync",
      "7 git execFileSync",
      "8 testFiles",
      "13 walk > readdirSync",
    ]);
    expect(cases.filter((c) => c.limited).map((c) => c.line)).toEqual([9, 10, 11, 12]);
  });
});
