/**
 * Detector for docs/contracts/wall-clock-assertions.md.
 *
 * Rule no-new-wall-clock-bound. A test that asserts how little wall-clock time
 * something took, `expect(Date.now() - started).toBeLessThan(500)`, measures
 * the machine as much as the code, and so does the same inequality written any
 * other way: a lower bound on the time left (`expect(until - Date.now())
 * .toBeGreaterThan(K)`), a stamp under a start plus slack, an average of timed
 * runs. Several agents share this machine and its load average passes 100;
 * such a bound then turns red on a change that has nothing to do with it.
 *
 * What counts is decided by the clock-taint analysis in
 * ./wall-clock-assertions-taint.ts: an ordering matcher whose target or bound
 * comes from a real clock read, except an order of two bare clock values and an
 * assertion whose every clock is proven frozen when it runs. The repository already holds the bounds counted
 * in WALL_CLOCK_BASELINE, file by file: this is a RATCHET. No file may gain
 * one, and a file whose count drops lowers its line here in the same change, so
 * the number only goes down. Raising a line is a loosened pin for
 * scripts/ci/check-test-integrity.mjs and needs a Test-Weakened line. The
 * contract lists what the analysis cannot see; each item is a fixture below.
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
import { type Bound, judgeBounds, wallClockBounds } from "./wall-clock-assertions-taint.js";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SELF = "src/tests/wall-clock-assertions.test.ts";
const { testFiles } = (await import(pathToFileURL(path.join(REPO, "scripts", "ci", "dist-build.mjs")).href)) as {
  testFiles(root: string): string[];
};

/**
 * Clock-tainted ordering assertions per test file, as this detector sees them. Measured
 * on main at 1d0d374a (2026-11-16): 299 in 103 files. Lower a count when you
 * replace a bound with fake timers or a counted event; delete its line at
 * zero. Never raise one, never add one.
 */
const WALL_CLOCK_BASELINE: Readonly<Record<string, number>> = {
  "src/agent-core/engine/tool-turn.guidance-exposure.test.ts": 3,
  "src/agent-core/engine/tool-turn.request-text.test.ts": 1,
  "src/agent-core/runner/v2-agent-runner.integration.test.ts": 4,
  "src/agents/autonomy/progress-assessment.test.ts": 3,
  "src/agents/iteration-health-tracker.test.ts": 2,
  "src/agents/memory-refresher.test.ts": 1,
  "src/agents/multi/agent-manager-memory-embedding.test.ts": 1,
  "src/agents/multi/agent-types.test.ts": 1,
  "src/agents/multi/delegation/delegation-manager.test.ts": 1,
  "src/agents/multi/workspace-change-review.test.ts": 1,
  "src/agents/orchestrator-provider-failover.test.ts": 1,
  "src/agents/orchestrator-reflection-handler.test.ts": 1,
  "src/agents/orchestrator-session-manager.test.ts": 1,
  "src/agents/provider-failure-notice.test.ts": 1,
  "src/agents/providers/claude-seat-review.test.ts": 3,
  "src/agents/providers/credential-rejected.test.ts": 1,
  "src/agents/providers/fallback-chain.test.ts": 8,
  "src/agents/providers/first-response-budget.test.ts": 1,
  "src/agents/providers/free-tier-limit.test.ts": 2,
  "src/agents/providers/provider-behavioral-profiles.test.ts": 1,
  "src/agents/providers/provider-features.test.ts": 1,
  "src/agents/providers/provider-health.test.ts": 1,
  "src/agents/providers/provider-outage.test.ts": 3,
  "src/agents/providers/quota-reset-from-message.test.ts": 4,
  "src/agents/review/codex-second-opinion.test.ts": 1,
  "src/agents/tools/browser-automation.test.ts": 2,
  "src/agents/tools/search-glob-cost.test.ts": 4,
  "src/agents/tools/search-regex-timeout.test.ts": 2,
  "src/bench/bounded-command.test.ts": 1,
  "src/campaign/acceptance-in-prompt.test.ts": 4,
  "src/campaign/campaign-intake.test.ts": 2,
  "src/campaign/campaign-ledger-lifecycle.test.ts": 3,
  "src/campaign/campaign-manager-dispose.test.ts": 1,
  "src/campaign/campaign-manager.test.ts": 39,
  "src/campaign/scope-settle-manager.test.ts": 4,
  "src/channels/discord/rate-limiter.test.ts": 4,
  "src/channels/slack/__tests__/rate-limiter.test.ts": 3,
  "src/channels/slack/app.test.ts": 1,
  "src/common/fetch-with-retry.test.ts": 2,
  "src/common/openai-subscription-auth.test.ts": 1,
  "src/config/strada-deps.test.ts": 1,
  "src/core/runtime-lock.test.ts": 1,
  "src/core/status-report.test.ts": 1,
  "src/daemon/deployment/bounded-process.test.ts": 3,
  "src/daemon/reporting/digest-formatter.test.ts": 5,
  "src/dashboard/canvas-routes.test.ts": 2,
  "src/dashboard/metrics.test.ts": 2,
  "src/dashboard/server-system-routes.test.ts": 1,
  "src/dashboard/server.test.ts": 2,
  "src/goals/goal-decomposer.test.ts": 1,
  "src/goals/goal-renderer.test.ts": 2,
  "src/goals/goal-storage.test.ts": 1,
  "src/identity/crash-recovery.test.ts": 2,
  "src/identity/identity-state.test.ts": 2,
  "src/intelligence/csharp-parser.test.ts": 2,
  "src/intelligence/framework/framework-git-fallback.test.ts": 2,
  "src/learning/chains/chain-detector.test.ts": 6,
  "src/learning/chains/chain-parallel.test.ts": 2,
  "src/learning/exposure-coverage.test.ts": 1,
  "src/learning/exposure-time.test.ts": 3,
  "src/learning/initial-confidence.test.ts": 4,
  "src/learning/matching/pattern-matcher-bounds.test.ts": 2,
  "src/learning/matching/pattern-matcher.test.ts": 9,
  "src/learning/non-application-evidence.test.ts": 1,
  "src/learning/pipeline/learning-pipeline.test.ts": 11,
  "src/learning/pipeline/learning-queue-bounds.test.ts": 1,
  "src/learning/pipeline/learning-queue.test.ts": 1,
  "src/learning/scoring/confidence-scorer.test.ts": 15,
  "src/learning/storage/learning-storage.test.ts": 2,
  "src/memory/unified/agentdb-adapter.test.ts": 1,
  "src/memory/unified/agentdb-decay-writes.test.ts": 2,
  "src/memory/unified/agentdb-retrieval.test.ts": 16,
  "src/memory/unified/agentdb-tiering.test.ts": 6,
  "src/memory/unified/consolidation-engine.test.ts": 4,
  "src/rag/chunker.test.ts": 1,
  "src/rag/docs/composite-rag-pipeline.test.ts": 5,
  "src/rag/file-pattern.test.ts": 2,
  "src/rag/hnsw/hnsw-integration.test.ts": 1,
  "src/rag/hnsw/hnsw-performance.test.ts": 6,
  "src/rag/hnsw/hnsw-vector-store.test.ts": 1,
  "src/rag/reranker.test.ts": 1,
  "src/rag/vector-store.test.ts": 7,
  "src/security/auth-hardened.test.ts": 1,
  "src/security/prompt-injection.test.ts": 1,
  "src/skills/bundled/file-utils/file-utils.test.ts": 1,
  "src/skills/bundled/web-search/web-search.test.ts": 1,
  "src/skills/project-files.test.ts": 1,
  "src/skills/skill-import-scan.test.ts": 1,
  "src/supervisor/__tests__/capability-matcher.test.ts": 3,
  "src/supervisor/__tests__/provider-assigner.test.ts": 4,
  "src/supervisor/__tests__/supervisor-dispatcher.test.ts": 7,
  "src/supervisor/dead-provider-stops-getting-work.test.ts": 1,
  "src/tasks/background-executor.test.ts": 1,
  "src/tasks/command-handler.test.ts": 2,
  "src/tasks/task-manager.test.ts": 1,
  "src/tasks/task-storage.test.ts": 1,
  "src/tests/integration/golden-run-failover.test.ts": 2,
  "src/tests/integration/rag-search.test.ts": 1,
  "src/utils/process-runner.test.ts": 4,
  "src/vault/canvas-generator.test.ts": 1,
  "src/vault/glob-match.test.ts": 1,
  "src/vault/unity-project-vault.test.ts": 1,
  "tests/vault/phase2.acceptance.test.ts": 1,
};

/** The limit a test that scans the repository carries, as clean-checkout.test.ts and dist-readers.test.ts do. */
const REPO_SCAN_TIMEOUT_MS = 120_000;

const NEW_BOUND_ADVICE =
  "A test gained an ordering assertion on a value from a real clock (docs/contracts/wall-clock-assertions.md): " +
  "an upper bound on time taken, a lower bound on time left, or the same inequality rearranged. On a machine " +
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

describe("wall-clock bounds in tests only go down (docs/contracts/wall-clock-assertions.md)", () => {
  it("no test file gained a wall-clock bound", () => {
    const { added } = judgeBounds(measureRepo(), WALL_CLOCK_BASELINE);
    expect(added, NEW_BOUND_ADVICE).toEqual([]);
  }, REPO_SCAN_TIMEOUT_MS);

  it("the baseline is lowered as soon as a bound goes away", () => {
    const { stale } = judgeBounds(measureRepo(), WALL_CLOCK_BASELINE);
    expect(stale, `lower these lines in WALL_CLOCK_BASELINE in ${SELF} (delete at zero) so the ratchet holds`).toEqual([]);
  }, REPO_SCAN_TIMEOUT_MS);

  /** A fixture file from `[line, form]` pairs; returns the file and the `line:form` the detector must report. */
  const spec = (entries: readonly (readonly [string, Bound["form"] | null])[]): { body: string; want: string[] } => ({
    body: entries.map(([line]) => line).join("\n"),
    want: entries.flatMap(([, form], i) => (form ? [`${i + 1} ${form}`] : [])),
  });
  const found = (root: string): string[] => wallClockBounds(root, testFiles(root)).map((b) => `${b.line} ${b.form}`);
  const foundIn = (root: string): string[] =>
    wallClockBounds(root, testFiles(root))
      .map((b) => `${b.file}:${b.line} ${b.form}`)
      .sort((x, y) => x.localeCompare(y, "en", { numeric: true }));

  it("counts an ordering assertion with a clock-tainted side, whatever its direction or arrangement", () => {
    const { body, want } = spec([
      ['import { performance as perf } from "node:perf_hooks";', null],
      ['import * as hooks from "node:perf_hooks";', null],
      ['import proc from "node:process";', null],
      ['import { hrtime } from "node:process";', null],
      ['import os from "node:os";', null],
      ["const t = Date.now();", null],
      ["expect(Date.now() - t).toBeLessThan(500);", "target"],
      ['expect(Date.now() - t, "late").toBeLessThanOrEqual(500);', "target"],
      ["expect(performance.now() - t).not.toBeGreaterThan(500);", "target"],
      ["expect(perf.now() - t).toBeLessThan(500);", "target"],
      ["expect(hooks.performance.now() - t).toBeLessThan(500);", "target"],
      ["const elapsed = Date.now() - t;", null],
      ["expect.soft(elapsed).toBeLessThan(500);", "target"],
      ["expect(entry.cooldownUntil - t).toBeLessThanOrEqual(500);", "target"],
      ["expect(result.expiresAt).toBeLessThanOrEqual(t + 36 * HOUR + 5_000);", "bound"],
      ["expect(entry.cooldownUntil - Date.now()).toBeGreaterThan(60_000 - 500);", "target"],
      ["expect(entry.cooldownUntil).toBeGreaterThan(Date.now() + 60_000 - 500);", "bound"],
      ["expect(t + 5_000).toBeGreaterThanOrEqual(result.expiresAt);", "target"],
      ["const deadline = Date.now() + 5_000;", null],
      ["expect(Date.now()).toBeLessThan(deadline);", "both"],
      ["const early = Date.now() - 1;", null],
      ["expect(result.expiresAt).toBeLessThanOrEqual(early + 5_000);", "bound"],
      ["const remainingMs = (): number => resetAt - Date.now();", null],
      ["expect(remainingMs()).toBeGreaterThan(2 * HOUR);", "target"],
      ["const times: number[] = [];", null],
      ["for (const q of queries) { const s = performance.now(); search(q); times.push(performance.now() - s); }", null],
      ["expect(times.reduce((a, b) => a + b, 0) / times.length).toBeLessThan(10);", "target"],
      ["for (const ms of times) expect(ms).toBeLessThan(10);", "target"],
      ["times.forEach((ms) => expect(ms).toBeLessThan(10));", "target"],
      ["async function measured() { const s = Date.now(); await work(); return { result: 1, ms: Date.now() - s }; }", null],
      ["const { ms } = await measured();", null],
      ["expect(ms).toBeLessThan(500);", "target"],
      ["const run = await measured();", null],
      ["expect(run.ms).toBeLessThan(500);", "target"],
      ['expect(run["ms"]).toBeLessThan(500);', "target"],
      ["await expect(measured().then((r) => r.ms)).resolves.toBeLessThan(500);", "target"],
      ["let took = 0;", null],
      ["took = Date.now() - t;", null],
      ["expect(took).toBeLessThan(500);", "target"],
      ["let lap = { ms: 0 };", null],
      ["lap = { ms: Date.now() - t };", null],
      ["expect(lap.ms).toBeLessThan(500);", "target"],
      ["const stats = { elapsed: 0 };", null],
      ["stats.elapsed = Date.now() - t;", null],
      ["expect(stats.elapsed).toBeLessThan(500);", "target"],
      ["const holder = { times: [] as number[] };", null],
      ["const kept = holder.times;", null],
      ["kept.push(Date.now() - t);", null],
      ["expect(holder.times[0]).toBeLessThan(500);", "target"],
      ["const [first] = [Date.now() - t];", null],
      ["expect(first).toBeLessThan(500);", "target"],
      ["const { inner: { ms: deep } } = { inner: { ms: Date.now() - t }, ms: 0 };", null],
      ["expect(deep).toBeLessThan(500);", "target"],
      ["expect(msSinceFailure(t + 90_000)).toBeLessThan(95_000);", "target"],
      ["const start = proc.hrtime.bigint();", null],
      ["expect(process.hrtime.bigint() - start).toBeLessThan(5_000_000n);", "target"],
      ["expect(hrtime.bigint() - start).toBeLessThan(5_000_000n);", "target"],
      ["expect(hrtime()[1]).toBeLessThan(5);", "target"],
      ["expect(process.uptime()).toBeLessThan(5);", "target"],
      ["expect(os.uptime()).toBeGreaterThan(5);", "target"],
      ["expect(new Date().getTime() - t).toBeLessThan(500);", "target"],
      ["expect(+new Date() - t).toBeLessThan(500);", "target"],
      ["expect(Math.abs(Date.now() - DAY - since)).toBeLessThan(500);", "target"],
      ["const laps = new Map<string, number>();", null],
      ['laps.set("a", Date.now() - t);', null],
      ['expect(laps.get("a")).toBeLessThan(500);', "target"],
      ["const end = Date.now();", null],
      ["expect(end).toBeLessThan(t + 500);", "both"],
    ]);
    expect(found(fixtureRoot({ "src/seen.test.ts": body }))).toEqual(want);
  });

  it("counts an assertion whose clock is not proven frozen when it runs", () => {
    const { body, want } = spec([
      ['describe("a", () => { beforeEach(() => { vi.useFakeTimers(); }); it("real again", () => { vi.useRealTimers(); expect(Date.now() - 1).toBeLessThan(5); }); });', "target"],
      ['it("spy passes through", () => { vi.spyOn(Date, "now"); expect(Date.now() - 1).toBeLessThan(5); });', "target"],
      ['it("advancing", () => { vi.useFakeTimers({ shouldAdvanceTime: true }); expect(Date.now() - 1).toBeLessThan(5); });', "target"],
      ['it("all restored", () => { vi.spyOn(Date, "now").mockReturnValue(5); vi.restoreAllMocks(); expect(Date.now() - 1).toBeLessThan(5); });', "target"],
      ['it("spy restored", () => { const spy = vi.spyOn(Date, "now").mockReturnValue(5); spy.mockRestore(); expect(Date.now() - 1).toBeLessThan(5); });', "target"],
      ['it("performance faked, Date read", () => { vi.useFakeTimers({ toFake: ["performance"] }); expect(Date.now() - 1).toBeLessThan(5); });', "target"],
      ['it("timeouts faked", () => { vi.useFakeTimers({ toFake: ["setTimeout"] }); expect(Date.now() - 1).toBeLessThan(5); });', "target"],
      ['it("Date faked, performance read", () => { vi.setSystemTime(5); expect(performance.now() - 1).toBeLessThan(5); });', "target"],
      ['it("once", () => { vi.spyOn(Date, "now").mockReturnValueOnce(5); expect(Date.now() - 1).toBeLessThan(5); });', "target"],
      ['it("reads through", () => { vi.spyOn(Date, "now").mockImplementation(() => realNow() + 5); expect(Date.now() - 1).toBeLessThan(5); });', "target"],
      ['it("ticking", () => { vi.useFakeTimers(); vi.setTimerTickMode("interval", 10); expect(Date.now() - 1).toBeLessThan(5); });', "target"],
      ["function unfreeze() { vi.useRealTimers(); }", null],
      ['it("undone by a helper", () => { vi.useFakeTimers(); unfreeze(); expect(Date.now() - 1).toBeLessThan(5); });', "target"],
      ['it("maybe faked", () => { if (flag) vi.useFakeTimers(); expect(Date.now() - 1).toBeLessThan(5); });', "target"],
      ['it("loop", () => { vi.useFakeTimers(); for (const n of [1, 2]) { expect(Date.now() - n).toBeLessThan(5); vi.useRealTimers(); } });', "target"],
      ['it("callback", () => { vi.useFakeTimers(); later(() => expect(Date.now() - 1).toBeLessThan(5)); vi.useRealTimers(); });', "target"],
      ['it("options unread", () => { vi.useFakeTimers(OPTIONS); expect(Date.now() - 1).toBeLessThan(5); });', "target"],
      ['it("set while advancing", () => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(5); expect(Date.now() - 1).toBeLessThan(5); });', "target"],
      ['it("uptime", () => { vi.useFakeTimers(); expect(process.uptime() - 1).toBeLessThan(5); });', "target"],
    ]);
    const inHook = spec([['beforeEach(() => { vi.useFakeTimers(); expect(Date.now() - 1).toBeLessThan(5); });', "target"]]);
    const sibling = spec([
      ['describe("held", () => {', null],
      ["  beforeAll(() => { vi.useFakeTimers(); });", null],
      ['  it("first", () => { vi.useRealTimers(); });', null],
      ['  it("second", () => { expect(Date.now() - 1).toBeLessThan(5); });', "target"],
      ["});", null],
    ]);
    const afterEachUndoes = spec([
      ['describe("held", () => {', null],
      ["  beforeAll(() => { vi.useFakeTimers(); });", null],
      ["  afterEach(() => { vi.useRealTimers(); });", null],
      ['  it("x", () => { expect(Date.now() - 1).toBeLessThan(5); });', "target"],
      ["});", null],
    ]);
    const innerAfterAll = spec([
      ["beforeAll(() => { vi.useFakeTimers(); });", null],
      ['describe("inner", () => { afterAll(() => { vi.useRealTimers(); }); it("a", () => {}); });', null],
      ['it("later", () => { expect(Date.now() - 1).toBeLessThan(5); });', "target"],
    ]);
    const root = fixtureRoot({
      "src/real.test.ts": body,
      "src/sibling.test.ts": sibling.body,
      "src/after-each.test.ts": afterEachUndoes.body,
      "src/inner-after-all.test.ts": innerAfterAll.body,
      "src/in-hook.test.ts": inHook.body,
    });
    expect(foundIn(root)).toEqual([
      ...afterEachUndoes.want.map((w) => `src/after-each.test.ts:${w}`),
      ...inHook.want.map((w) => `src/in-hook.test.ts:${w}`),
      ...innerAfterAll.want.map((w) => `src/inner-after-all.test.ts:${w}`),
      ...want.map((w) => `src/real.test.ts:${w}`),
      ...sibling.want.map((w) => `src/sibling.test.ts:${w}`),
    ]);
  });

  it("leaves out an order of two bare clock values, an assertion with every clock frozen, and one with no clock in it", () => {
    const root = fixtureRoot({
      "src/excluded.test.ts": [
        'import { performance as fake } from "./fake-clock.js";',
        "const a = Date.now();",
        "const b = Date.now();",
        "expect(b).toBeGreaterThanOrEqual(a);",
        "const fast = performance.now() - a;",
        "const slow = performance.now() - b;",
        "expect(fast).toBeLessThan(slow);",
        "expect(rows.length).toBeLessThan(5);",
        "expect(x).toBeGreaterThan(limit + 1);",
        "let time = 1_000_000;",
        "time += HOUR;",
        "expect(entry.cooldownUntil).toBeLessThan(time + HOUR);",
        "function f(Date: { now(): number }) { expect(Date.now() - 5).toBeLessThan(5); }",
        "expect(fake.now() - 5).toBeLessThan(5);",
      ].join("\n"),
      "src/frozen.test.ts": [
        'describe("hooked", () => { beforeEach(() => { vi.useFakeTimers(); }); it("x", () => { expect(Date.now() - 1).toBeLessThan(5); }); });',
        'describe("arrow hook", () => { beforeEach(() => vi.useFakeTimers()); it("x", () => { expect(performance.now() - 1).toBeLessThan(5); }); });',
        'describe("undone after", () => { beforeEach(() => { vi.useFakeTimers(); }); afterEach(() => { vi.useRealTimers(); }); it("a", () => { vi.useRealTimers(); }); it("b", () => { expect(Date.now() - 1).toBeLessThan(5); }); });',
        'it("faked", () => { vi.useFakeTimers(); const t0 = Date.now(); expect(Date.now() - t0).toBeLessThan(5); vi.useRealTimers(); });',
        'it("Date only", () => { vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: false }); expect(Date.now() - 1).toBeLessThan(5); });',
        'it("hrtime", () => { vi.useFakeTimers(); expect(process.hrtime.bigint() - 1n).toBeLessThan(5n); });',
        'it("set", () => { vi.setSystemTime(5); expect(Date.now() - 1).toBeLessThan(5); });',
        'it("set on fake", () => { vi.useFakeTimers().setSystemTime(5); expect(performance.now() - 1).toBeLessThan(5); });',
        'it("spied", () => { vi.spyOn(Date, "now").mockReturnValue(5); expect(Date.now() - 1).toBeLessThan(5); });',
        'it("spied perf", () => { vi.spyOn(performance, "now").mockImplementation(() => clock); expect(performance.now() - 1).toBeLessThan(5); });',
        'it("named spy", () => { const spy = vi.spyOn(Date, "now"); spy.mockReturnValue(5); expect(Date.now() - 1).toBeLessThan(5); });',
        'it("manual ticks", () => { vi.useFakeTimers(); vi.setTimerTickMode("manual"); expect(Date.now() - 1).toBeLessThan(5); });',
        'it("in a block", () => { vi.useFakeTimers(); try { expect(Date.now() - 1).toBeLessThan(5); } finally { vi.useRealTimers(); } });',
      ].join("\n"),
      "src/frozen-at-collection.test.ts":
        'describe("plain", () => { vi.useFakeTimers(); it("y", () => { expect(Date.now() - 1).toBeLessThan(5); }); });\n',
      "src/frozen-for-all.test.ts":
        'describe("all", () => { beforeAll(() => { vi.useFakeTimers(); }); afterAll(() => { vi.useRealTimers(); }); it("z", () => { expect(Date.now() - 1).toBeLessThan(5); }); });\n',
    });
    expect(foundIn(root)).toEqual([]);
  });

  it("cannot see a clock read through what the contract lists under 'What it cannot see'", () => {
    const root = fixtureRoot({
      "src/timing.ts": "export const timed = (run: () => void): number => { const s = Date.now(); run(); return Date.now() - s; };\n",
      "src/unfreeze.ts": "export const unfreeze = (): void => { vi.useRealTimers(); };\n",
      "src/blind.test.ts": [
        'import { timed } from "./timing.js";',
        'import { unfreeze } from "./unfreeze.js";',
        "expect(timed(work)).toBeLessThan(5);",
        "logCall(Date.now() - 160_000);",
        "expect(medianMs()).toBeLessThan(165_000);",
        "function fast(ms: number) { expect(ms).toBeLessThan(100); }",
        "fast(Date.now() - 5);",
        "function fill(into: { ms: number }) { into.ms = Date.now() - 5; }",
        "const box = { ms: 0 };",
        "fill(box);",
        "expect(box.ms).toBeLessThan(5);",
        "class Clock { start = Date.now(); took() { return Date.now() - this.start; } }",
        "const c = new Clock();",
        "expect(c.took()).toBeLessThan(5);",
        "const now = Date.now;",
        "expect(now() - 5).toBeLessThan(5);",
        "expect(globalThis.Date.now() - 5).toBeLessThan(5);",
        "expect(Date.now.bind(Date)() - 5).toBeLessThan(5);",
        "expect(Date.now() - 5 < 500).toBe(true);",
        "assert.ok(Date.now() - 5 < 500);",
        "expect(Date.now() - 5).toSatisfy((ms: number) => ms < 500);",
        'expect(Date.now() - 5)["toBeLessThan"](500);',
        "expect(Date.now() - 5).to.be.below(500);",
        'it("undone by an imported helper", () => { vi.useFakeTimers(); unfreeze(); expect(Date.now() - 1).toBeLessThan(5); });',
      ].join("\n"),
    });
    expect(found(root)).toEqual([]);
  });

  it("counts too much where the contract says it errs toward counting", () => {
    const { body, want } = spec([
      ["expect(deadline - Date.now()).toBeLessThan(60_000);", "target"],
      ["const after = Date.now();", null],
      ["expect(state.stamp).toBeLessThanOrEqual(after);", "bound"],
      ['function freeze() { vi.spyOn(Date, "now").mockReturnValue(5); }', null],
      ['it("frozen by a helper", () => { freeze(); expect(Date.now() - 1).toBeLessThan(5); });', "target"],
      ["expect(items.filter((i) => i.at < Date.now()).length).toBeLessThan(3);", "target"],
      ["const tasks = makeTasks(Date.now());", null],
      ["const asked: string[] = [];", null],
      ['vi.spyOn(tasks, "getStatus").mockImplementation((id: string) => { asked.push(id); return 1; });', null],
      ['expect(asked.indexOf("a")).toBeLessThan(3);', "target"],
    ]);
    const heldThenElsewhere = spec([
      ['describe("a", () => { vi.useFakeTimers(); it("x", () => { expect(Date.now() - 1).toBeLessThan(5); }); });', "target"],
      ['describe("b", () => { beforeEach(() => { vi.useFakeTimers(); }); });', null],
    ]);
    const root = fixtureRoot({ "src/over.test.ts": body, "src/over-held.test.ts": heldThenElsewhere.body });
    expect(foundIn(root)).toEqual([
      ...heldThenElsewhere.want.map((w) => `src/over-held.test.ts:${w}`),
      ...want.map((w) => `src/over.test.ts:${w}`),
    ]);
  });

  it("turns red on a new expect(Date.now() - t).toBeLessThan(500), and green once the baseline holds it", () => {
    const root = fixtureRoot({
      "src/fresh.test.ts": "const t = Date.now();\nawait work();\nexpect(Date.now() - t).toBeLessThan(500);\n",
      "src/kept.test.ts": "const t = Date.now();\nconst elapsed = Date.now() - t;\nexpect(elapsed).toBeLessThan(900);\n",
    });
    const bounds = wallClockBounds(root, testFiles(root));
    const kept = { "src/kept.test.ts": 1 };
    expect(judgeBounds(bounds, kept).added).toEqual([
      "src/fresh.test.ts: 1 wall-clock bound(s), baseline 0\n  src/fresh.test.ts:3  expect(Date.now() - t).toBeLessThan(500)",
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
