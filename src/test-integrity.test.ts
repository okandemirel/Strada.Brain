/**
 * Detector for docs/contracts/test-integrity.md, rule no-test-bent-to-green.
 *
 * Two layers. The commit layer is scripts/ci/check-test-integrity.mjs: CI and
 * the pre-push hook run it over every pushed commit, comparing each with its
 * parent, so a test case or assertion that disappears, a skip that appears, or
 * an assertion rewritten in a commit that changes no source needs a
 * `Test-Weakened:` line in that commit. This file pins that script's decision
 * on fixtures, and holds the tree itself:
 *
 *   - no test file holds a commented-out case or assertion;
 *   - skip markers (skip, todo, fails, only, skipIf, runIf, xit, xdescribe)
 *     are a RATCHET: a file may keep the count below, never grow one, and a
 *     file that sheds one lowers its line here in the same change. Raising a
 *     line is itself a weakening the commit layer names.
 *
 * Fixture source below is written with « for "(" and · for "." (see `js`), so
 * that this file's own fixtures are not counted as its cases, assertions or
 * skips by the scanner it tests.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SELF = "src/test-integrity.test.ts";
const SCAN_ROOTS = ["src", "tests", "web-portal/src"];

interface Counts {
  cases: number;
  assertions: number;
  skips: number;
  commented: number;
}
interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
  removedAssertions: number;
}
interface Pin {
  file: string;
  name: string;
  shape: "record" | "number";
  direction: "up" | "down";
}
type PinValue = number | Record<string, number> | null;
interface Guard {
  TRAILER: RegExp;
  PINS: Pin[];
  isTestPath(path: string): boolean;
  measureTestText(text: string): Counts;
  removedAssertionLines(diff: string): number;
  findWeakening(input: { files: FileChange[]; sourceChanged: boolean }): string[];
  readPin(text: string | null, pin: Pin): PinValue;
  pinLoosening(pin: Pin, before: PinValue, after: PinValue): string[];
  judgeCommit(input: {
    message: string;
    files: FileChange[];
    sourceChanged: boolean;
    pins: Array<{ pin: Pin; before: PinValue; after: PinValue }>;
  }): { findings: string[]; justification: string | null };
}

const guard = (await import(pathToFileURL(join(REPO, "scripts/ci/check-test-integrity.mjs")).href)) as Guard;

/** Fixture source: « is "(" and · is ".", so the scanner never counts this file's fixtures as its own. */
const js = (s: string): string => s.replace(/«/g, "(").replace(/·/g, ".");

/**
 * Skip markers per test file when the contract was written (2026-11-04: 86 in
 * 46 files). Most are platform or environment gates (POSIX-only shebangs, a
 * Strada.Core checkout that CI does not have). Lower a count when you remove
 * one; delete the line at zero. Never raise one, never add one — that is a
 * weakening, and the commit layer will ask the commit to say why.
 */
const SKIP_BASELINE: Readonly<Record<string, number>> = {
  "src/agents/autonomy/spec-scope.test.ts": 1,
  "src/agents/context/strada-core-api-fidelity.test.ts": 8,
  "src/agents/tools/browser-automation.test.ts": 1,
  "src/agents/tools/file-read-authorized.test.ts": 1,
  "src/agents/tools/strada/module-folders.test.ts": 5,
  "src/agents/tools/strada/module-templates.test.ts": 4,
  "src/agents/tools/unity/prerender-frames.test.ts": 2,
  "src/assets-local/local-model-runner.test.ts": 1,
  "src/bench/bounded-command.test.ts": 1,
  "src/bench/swe-sharp-runner.test.ts": 2,
  "src/campaign/campaign-fingerprint-coarse-clock.test.ts": 1,
  "src/campaign/campaign-scope-report.test.ts": 1,
  "src/common/project-write-lock.test.ts": 1,
  "src/common/strada-home-entry.test.ts": 1,
  "src/config/preset-cli.test.ts": 1,
  "src/core/auto-updater-spawn.test.ts": 2,
  "src/core/bind-host.test.ts": 1,
  "src/core/database-backup.test.ts": 1,
  "src/daemon/deployment/bounded-process.test.ts": 1,
  "src/daemon/deployment/deployment-executor.realfs.test.ts": 2,
  "src/dashboard/prometheus.test.ts": 1,
  "src/dashboard/websocket-server.test.ts": 2,
  "src/rag/hnsw/hnsw-exact-fallback.test.ts": 1,
  "src/rag/hnsw/hnsw-integration.test.ts": 1,
  "src/rag/hnsw/hnsw-performance.test.ts": 4,
  "src/rag/hnsw/hnsw-persistence.test.ts": 1,
  "src/rag/hnsw/hnsw-vector-store.test.ts": 1,
  "src/security/path-guard-real-form.test.ts": 1,
  "src/skills/bundled/file-utils/file-utils.test.ts": 3,
  "src/tests/integration/entry-guard-symlink.test.ts": 1,
  "src/tests/integration/file-build-flow.test.ts": 1,
  "src/tests/integration/index-cli.test.ts": 2,
  "src/tests/integration/source-launcher.test.ts": 7,
  "src/tests/integration/strada-unity-fixture.test.ts": 1,
  "src/tests/unit/backup-script.test.ts": 2,
  "src/tests/unit/deploy-script.test.ts": 4,
  "src/tests/unit/npm-package-contract.test.ts": 2,
  "src/tests/unit/restore-script.test.ts": 1,
  "src/tests/unit/security-scan-script.test.ts": 1,
  "src/tests/unit/systemd-unit-contract.test.ts": 1,
  "src/universality.test.ts": 2,
  "src/utils/process-runner.test.ts": 4,
  "src/vault/obsidian-vault.test.ts": 1,
  "src/vault/self-vault.test.ts": 1,
  "src/vault/unity-project-vault.test.ts": 1,
  "tests/eval/export-campaign-fixture.test.ts": 1,
};

const OLD = js(`describe«"parser", () => {
  it«"reads a header", () => {
    expect«parse«"# A"))·toEqual«{ title: "A" });
    expect«parse«"#"))·toBeNull«);
  });
  it«"reads a body", () => {
    expect«parse«"x")·body)·toBe«"x");
  });
});
`);

const change = (after: string | null, extra: Partial<FileChange> = {}): FileChange => ({
  path: "src/parser.test.ts",
  before: OLD,
  after,
  removedAssertions: 0,
  ...extra,
});

describe("the commit layer names a test bent to green (docs/contracts/test-integrity.md)", () => {
  it("reads the shapes it counts, and not prose that merely mentions them", () => {
    expect(guard.measureTestText(OLD)).toEqual({ cases: 2, assertions: 3, skips: 0, commented: 0 });
    const skipped = js(`it·skip«"a", f);\ntest·todo«"b");\ndescribe·skipIf«win)«"c", f);\nit·only«"d", f);\nxit«"e", f);`);
    expect(guard.measureTestText(skipped).skips).toBe(5);
    expect(guard.measureTestText(js(`// it«"was here", () => {\n  // expect«x)·toBe«1);`)).commented).toBe(2);
    expect(guard.measureTestText(js(`// it «Codex, round 7) became a bundle\n// test the parser`)).commented).toBe(0);
    expect(guard.measureTestText(js(`const ok = /x/·test«s);`)).cases).toBe(0);
  });

  it("names a removed case and a removed assertion", () => {
    const fewer = js(`describe«"parser", () => {\n  it«"reads a header", () => {\n    expect«parse«"# A"))·toEqual«{ title: "A" });\n  });\n});\n`);
    const found = guard.findWeakening({ files: [change(fewer)], sourceChanged: true });
    expect(found).toEqual([
      "src/parser.test.ts: 1 test case(s) removed",
      "src/parser.test.ts: 2 assertion(s) removed",
    ]);
  });

  it("names an added skip and a commented-out case, even when the case count holds", () => {
    const skipped = OLD.replace(js(`it«"reads a body"`), js(`it·skip«"reads a body"`));
    expect(guard.findWeakening({ files: [change(skipped)], sourceChanged: true })).toEqual([
      "src/parser.test.ts: 1 skip/only/todo marker(s) added",
    ]);
    const commented = OLD.replace(js(`  it«"reads a body", () => {`), js(`  // it«"reads a body", () => {\n  it«"reads a body later", () => {`));
    expect(guard.findWeakening({ files: [change(commented)], sourceChanged: true })).toEqual([
      "src/parser.test.ts: 1 commented-out test or assertion line(s) added",
    ]);
  });

  it("names a deleted test file and a new one that ships skipped", () => {
    expect(guard.findWeakening({ files: [change(null)], sourceChanged: true })).toEqual([
      "src/parser.test.ts: test file deleted (2 cases, 3 assertions)",
    ]);
    const born = { path: "src/new.test.ts", before: null, after: js(`it·todo«"later");`), removedAssertions: 0 };
    expect(guard.findWeakening({ files: [born], sourceChanged: true })).toEqual([
      "src/new.test.ts: 1 skip/only/todo marker(s) added",
    ]);
  });

  it("names an assertion rewritten by a commit that changes no source — and not one that follows a source change", () => {
    // The 375b55d0 shape: same number of assertions, a looser one, and no code changed.
    const looser = OLD.replace(js(`toBe«"x")`), js(`toBeTruthy«)`));
    const rewritten = change(looser, { removedAssertions: 1 });
    expect(guard.findWeakening({ files: [rewritten], sourceChanged: false })).toEqual([
      "src/parser.test.ts: 1 existing assertion line(s) rewritten in a commit that changes no source",
    ]);
    expect(guard.findWeakening({ files: [rewritten], sourceChanged: true })).toEqual([]);
    const diff = js(`--- a/x.test.ts\n+++ b/x.test.ts\n-    expect«a)·toBe«"x");\n+    expect«a)·toBeTruthy«);\n-  // expect«b);`);
    expect(guard.removedAssertionLines(diff)).toBe(1);
  });

  it("passes a commit that only adds tests", () => {
    const more = OLD.replace(/\}\);\n$/, js(`  it«"reads a footer", () => {\n    expect«1)·toBe«1);\n  });\n});\n`));
    expect(guard.findWeakening({ files: [change(more)], sourceChanged: false })).toEqual([]);
  });

  it("accepts a weakening only with its own Test-Weakened sentence", () => {
    const input = { files: [change(null)], sourceChanged: true, pins: [] };
    const said = "fix: drop the v1 parser\n\nTest-Weakened: the v1 parser and its tests are gone; v2 is covered in parser-v2.test.ts.\n";
    expect(guard.judgeCommit({ ...input, message: said }).justification).toMatch(/^Test-Weakened: the v1 parser/);
    expect(guard.judgeCommit({ ...input, message: "fix: x\n\nTest-Weakened: ok\n" }).justification).toBeNull();
    expect(guard.judgeCommit({ ...input, message: "fix: x\n\nthe test was wrong\n" }).justification).toBeNull();
  });

  it("names every loosened pin, and no tightened one", () => {
    const [baseline, skips, none, counts] = guard.PINS;
    expect(guard.pinLoosening(baseline!, { "a.ts": 1 }, { "a.ts": 2, "b.ts": 1 })).toEqual([
      "src/path-containment-ratchet.test.ts BASELINE a.ts 1 -> 2",
      "src/path-containment-ratchet.test.ts BASELINE gained b.ts (1)",
    ]);
    expect(guard.pinLoosening(skips!, { "a.ts": 2 }, { "a.ts": 1 })).toEqual([]);
    expect(guard.pinLoosening(none!, 2, 3)).toEqual(["src/goals/gate-askers.test.ts PINNED_NONE 2 -> 3"]);
    expect(guard.pinLoosening(none!, 3, 2)).toEqual([]);
    expect(guard.pinLoosening(counts!, { rules: 3, errorRules: 3 }, { rules: 2 })).toEqual([
      "src/contracts.test.ts PINNED rules 3 -> 2",
      "src/contracts.test.ts PINNED errorRules 3 -> gone",
    ]);
    expect(guard.pinLoosening(counts!, { rules: 3 }, { rules: 4 })).toEqual([]);
    expect(guard.pinLoosening(none!, 2, null)).toEqual(["src/goals/gate-askers.test.ts PINNED_NONE removed"]);
    expect(guard.pinLoosening(none!, null, 5)).toEqual([]);
  });

  it("can read every pin it guards from the tree as it is", () => {
    // A renamed constant would make a pin invisible to the parent comparison.
    for (const pin of guard.PINS) {
      const value = guard.readPin(readFileSync(join(REPO, pin.file), "utf8"), pin);
      expect(value, `${pin.file} ${pin.name}`).not.toBeNull();
      if (pin.shape === "record") expect(Object.keys(value as Record<string, number>).length).toBeGreaterThan(0);
    }
  });
});

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "static") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) testFiles(full, out);
    else if (guard.isTestPath(entry)) out.push(full);
  }
  return out;
}

function treeCounts(): Map<string, Counts> {
  const counts = new Map<string, Counts>();
  for (const root of SCAN_ROOTS) {
    for (const file of testFiles(join(REPO, root))) {
      const shown = relative(REPO, file).split(sep).join("/");
      if (shown === SELF) continue;
      counts.set(shown, guard.measureTestText(readFileSync(file, "utf8")));
    }
  }
  return counts;
}

describe("the tree holds no test bent to green (docs/contracts/test-integrity.md)", () => {
  const counts = treeCounts();

  it("no test file holds a commented-out case or assertion", () => {
    const commented = [...counts].filter(([, c]) => c.commented > 0).map(([f, c]) => `${f}: ${c.commented}`);
    expect(commented, "delete the test, or make it run — a commented-out test is a passing lie").toEqual([]);
  });

  it("no file gained a skip marker", () => {
    const grown = [...counts]
      .filter(([f, c]) => c.skips > (SKIP_BASELINE[f] ?? 0))
      .map(([f, c]) => `${f}: ${SKIP_BASELINE[f] ?? 0} -> ${c.skips}`);
    expect(grown, "make the test run here, or justify the skip with Test-Weakened: in the commit").toEqual([]);
  });

  it("the skip baseline is lowered as soon as a skip goes away", () => {
    const stale = Object.entries(SKIP_BASELINE)
      .filter(([f, n]) => (counts.get(f)?.skips ?? 0) < n)
      .map(([f, n]) => `${f}: baseline ${n}, now ${counts.get(f)?.skips ?? 0}`);
    expect(stale, "lower these lines in SKIP_BASELINE (delete at zero) so the ratchet holds").toEqual([]);
  });

  it("CI and the pre-push hook both run the commit layer", () => {
    // Textual tripwire: a guard nothing runs is the defect this repo keeps finding.
    const ci = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("node scripts/ci/check-test-integrity.mjs");
    expect(ci).toMatch(/fetch-depth:\s*0/);
    expect(readFileSync(join(REPO, "scripts/git-hooks/pre-push"), "utf8")).toContain("scripts/ci/check-test-integrity.mjs");
    expect(readFileSync(join(REPO, "scripts/install-git-hooks.mjs"), "utf8")).toMatch(/"pre-push"/);
  });
});
