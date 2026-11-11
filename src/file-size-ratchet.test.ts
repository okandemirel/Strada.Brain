/**
 * Detector for docs/contracts/file-size.md, rule no-file-grows-past-the-limit.
 *
 * A source file over LIMIT lines is where every feature lands and nobody can
 * read: campaign-manager.ts reached 11,538 lines with 308 commits in two
 * months, and the owner's first answer to "what keeps breaking" was the
 * classes thousands of lines long that no AI could read whole (2026-11-04).
 * When this was written 64 files under src/ were over the limit (122,605
 * lines, 41% of the source).
 *
 * A RATCHET: a file in SIZE_BASELINE may keep the length it had and never
 * grow; any other file stays at or under LIMIT. A feature that would grow a
 * file over the limit goes into a new module beside it. When a baselined file
 * shrinks by SLACK lines or more, lower its line here in the same change, so
 * the room an extraction made cannot quietly be filled again. Raising a line
 * is a loosened pin: scripts/ci/check-test-integrity.mjs asks that commit to
 * say why (Test-Weakened:).
 *
 * This tree-level check cannot see a file that grows into the room under its
 * line (#31: orchestrator-session-manager.ts 1631 -> 1633 under 1650, all
 * gates green). The commit layer holds that: check-test-integrity.mjs compares
 * each baselined file at the head with itself at the base. The last block here
 * pins that decision on a real git history.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const LIMIT = 1000;
const SLACK = 100;

/** Lines per oversized file on 2026-11-04. Lower as files shrink; delete a line at or under LIMIT. */
const SIZE_BASELINE: Readonly<Record<string, number>> = {
  "src/campaign/campaign-manager.ts": 11532,
  "src/agents/orchestrator.ts": 6765,
  "src/learning/storage/learning-storage.ts": 4089,
  "src/channels/web/channel.ts": 3623,
  "src/tasks/background-executor.ts": 3425,
  "src/agents/multi/workspace-lease-manager.ts": 3091,
  "src/core/bootstrap.ts": 2820,
  "src/learning/pipeline/learning-pipeline.ts": 2812,
  "src/daemon/daemon-cli.ts": 2629,
  "src/campaign/acceptance-files.ts": 2619,
  "src/agents/tools/browser-automation.ts": 2457,
  "src/core/database-backup.ts": 2394,
  "src/tasks/command-handler.ts": 2291,
  "src/agents/autonomy/strada-conformance.ts": 2206,
  "src/core/auto-updater.ts": 2126,
  "src/agents/autonomy/built-as-specified.ts": 2008,
  "src/config/config.ts": 1999,
  "src/daemon/daemon-storage.ts": 1862,
  "src/core/setup-wizard.ts": 1857,
  "src/memory/unified/agentdb-memory.ts": 1838,
  "src/agents/orchestrator-intervention-pipeline.ts": 1828,
  "src/agents/providers/openai.ts": 1718,
  "src/campaign/requirement-rows.ts": 1689,
  "src/core/terminal-wizard.ts": 1672,
  "src/agents/orchestrator-session-manager.ts": 1650,
  "src/agents/multi/delegation/delegation-manager.ts": 1642,
  "src/core/strada-mcp-tool-loader.ts": 1580,
  "src/channels/discord/bot.ts": 1521,
  "src/core/bootstrap-stages/stage-runtime.ts": 1497,
  "src/intelligence/csharp-deep-parser.ts": 1485,
  "src/config/strada-deps.ts": 1472,
  "src/rag/hnsw/hnsw-vector-store.ts": 1447,
  "src/campaign/delivery-package.ts": 1433,
  "src/agents/providers/model-intelligence.ts": 1411,
  "src/campaign/campaign-planner.ts": 1410,
  "src/agents/tools/unity/sprite-generate.ts": 1389,
  "src/agent-core/runner/v2-agent-runner.ts": 1387,
  "src/assets-local/local-model-runner.ts": 1345,
  "src/agents/providers/fallback-chain.ts": 1313,
  "src/memory/file-memory-manager.ts": 1286,
  "src/dashboard/server.ts": 1281,
  "src/supervisor/supervisor-brain.ts": 1277,
  "src/agents/multi/agent-manager.ts": 1254,
  "src/agents/multi/workspace-change-review.ts": 1252,
  "src/campaign/campaign-intake.ts": 1240,
  "src/memory/unified/agentdb-adapter.ts": 1240,
  "src/campaign/campaign-storage.ts": 1236,
  "src/security/auth-hardened.ts": 1236,
  "src/config/config-schema.ts": 1227,
  "src/agent-core/routing/provider-router.ts": 1197,
  "src/channels/slack/app.ts": 1197,
  "src/agents/orchestrator-reflection-handler.ts": 1180,
  "src/bench/swe-sharp-runner.ts": 1178,
  "src/campaign/gdd-claims.ts": 1163,
  "src/memory/unified/consolidation-engine.ts": 1157,
  "src/daemon/heartbeat-loop.ts": 1137,
  "src/core/tool-registry.ts": 1129,
  "src/tasks/task-manager.ts": 1108,
  "src/index.ts": 1093,
  "src/learning/types.ts": 1077,
  "src/agents/autonomy/self-verification.ts": 1063,
  "src/agents/providers/provider-manager.ts": 1041,
  "src/agents/tools/unity/mesh-generate.ts": 1013,
  "src/agents/orchestrator-end-turn-handler.ts": 1005,
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.ts$/.test(entry) && !/\.(test|spec)\.ts$|\.d\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

function measure(): Map<string, number> {
  const lines = new Map<string, number>();
  for (const file of sourceFiles(SRC_DIR)) {
    const shown = `src/${relative(SRC_DIR, file).split(sep).join("/")}`;
    lines.set(shown, readFileSync(file, "utf8").split("\n").length - 1);
  }
  return lines;
}

describe("no source file grows past the limit (docs/contracts/file-size.md)", () => {
  const lines = measure();

  it(`no file outside the baseline is over ${LIMIT} lines`, () => {
    const over = [...lines].filter(([f, n]) => n > LIMIT && !(f in SIZE_BASELINE)).map(([f, n]) => `${f}: ${n}`);
    expect(over, `split it: a new module beside the file, not more lines in it`).toEqual([]);
  });

  it("no baselined file grew", () => {
    const grown = Object.entries(SIZE_BASELINE)
      .filter(([f, n]) => (lines.get(f) ?? 0) > n)
      .map(([f, n]) => `${f}: ${n} -> ${lines.get(f)}`);
    expect(grown, "move the new code into a module of its own, or take as many lines out as you add").toEqual([]);
  });

  it(`a baselined file that shrank by ${SLACK}+ lines has its line lowered`, () => {
    const stale = Object.entries(SIZE_BASELINE)
      .filter(([f, n]) => (lines.get(f) ?? 0) <= n - SLACK)
      .map(([f, n]) => `${f}: baseline ${n}, now ${lines.get(f) ?? "gone"}`);
    expect(stale, "lower these lines in SIZE_BASELINE (delete at or under the limit)").toEqual([]);
  });
});

interface SizePin {
  file: string;
  name: string;
  shape: "record";
  direction: "up";
}
interface Guard {
  SIZE_PIN: SizePin;
  countLines(text: string): number;
  baselineGrowth(
    baseline: Record<string, number> | null,
    before: (file: string) => string | null,
    after: (file: string) => string | null,
  ): Array<{ file: string; from: number; to: number }>;
  pinLoosening(pin: SizePin, before: Record<string, number>, after: Record<string, number>): string[];
}

const REPO = fileURLToPath(new URL("..", import.meta.url));
const GUARD_PATH = join(REPO, "scripts/ci/check-test-integrity.mjs");
const guard = (await import(pathToFileURL(GUARD_PATH).href)) as Guard;

const linesOf = (n: number): string => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};\n`).join("");

describe("the commit layer sees a baselined file grow under its line (scripts/ci/check-test-integrity.mjs)", () => {
  it("counts lines the way this file measures them", () => {
    expect(guard.countLines(linesOf(3))).toBe(3);
    const big = "src/agents/orchestrator-session-manager.ts";
    expect(guard.countLines(readFileSync(join(REPO, big), "utf8"))).toBe(measure().get(big));
  });

  it("names a baselined file that is one line longer, under its line, and no file that shrank or vanished", () => {
    const baseline = { "src/big.ts": 1650, "src/small.ts": 1200, "src/gone.ts": 1100 };
    const before: Record<string, string> = { "src/big.ts": linesOf(1631), "src/small.ts": linesOf(1100), "src/gone.ts": linesOf(1090) };
    const after: Record<string, string> = { "src/big.ts": linesOf(1632), "src/small.ts": linesOf(1099) };
    expect(
      guard.baselineGrowth(baseline, (f) => before[f] ?? null, (f) => after[f] ?? null),
    ).toEqual([{ file: "src/big.ts", from: 1631, to: 1632 }]);
    expect(guard.baselineGrowth(null, () => "", () => "x\n")).toEqual([]);
  });

  it("still names a raised or added SIZE_BASELINE line as a loosened pin", () => {
    const where = `${guard.SIZE_PIN.file} ${guard.SIZE_PIN.name}`;
    expect(guard.pinLoosening(guard.SIZE_PIN, { "src/big.ts": 1650 }, { "src/big.ts": 1651, "src/new.ts": 1001 })).toEqual([
      `${where} src/big.ts 1650 -> 1651`,
      `${where} gained src/new.ts (1001)`,
    ]);
    expect(guard.pinLoosening(guard.SIZE_PIN, { "src/big.ts": 1650 }, { "src/big.ts": 1640 })).toEqual([]);
  });

  /** A throwaway repo whose SIZE_BASELINE pins src/big.ts at 1650 while it holds 1631 lines. */
  function history() {
    const dir = mkdtempSync(join(tmpdir(), "file-size-growth-"));
    // A hook's GIT_DIR or GIT_INDEX_FILE would point these commands at the real repository.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
    const git = (...args: string[]): string => {
      const r = spawnSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
        { cwd: dir, env, encoding: "utf8" },
      );
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    const write = (file: string, text: string): void => {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    };
    const pins = (big: number): string => `const ${guard.SIZE_PIN.name} = {\n  "src/big.ts": ${big},\n};\n`;
    const commit = (message: string, files: Record<string, string>): string => {
      for (const [file, text] of Object.entries(files)) write(file, text);
      git("add", "--", ...Object.keys(files));
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD");
    };
    git("init", "-q");
    const base = commit("base", { [guard.SIZE_PIN.file]: pins(1650), "src/big.ts": linesOf(1631) });
    const judge = (head: string) => {
      const r = spawnSync(process.execPath, [GUARD_PATH, "--base", base, "--head", head], { cwd: dir, env, encoding: "utf8" });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    };
    return { dir, pins, commit, judge };
  }

  it("refuses one line added to a baselined file under its line, and passes it with a Test-Weakened line", () => {
    const h = history();
    try {
      const grew = h.commit("feat: one more line", { "src/big.ts": linesOf(1632) });
      const red = h.judge(grew);
      expect(red.status, red.out).toBe(1);
      expect(red.out).toContain("baselined file grew: src/big.ts 1631 -> 1632");
      const said = h.commit("feat: two more lines\n\nTest-Weakened: the hook must sit in the loop it guards, nowhere else.", {
        "src/big.ts": linesOf(1633),
      });
      const justified = h.judge(said);
      expect(justified.status, justified.out).toBe(0);
      expect(justified.out).toContain("1 baselined file(s) grew (1 justified)");
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it("passes an extraction and a later addition that leave the file no longer than it began", () => {
    const h = history();
    try {
      h.commit("refactor: extract a module", { "src/big.ts": linesOf(1620), "src/big-part.ts": linesOf(11) });
      const head = h.commit("feat: the call", { "src/big.ts": linesOf(1631) });
      const green = h.judge(head);
      expect(green.status, green.out).toBe(0);
      expect(green.out).toContain("0 baselined file(s) grew");
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it("still refuses a raised SIZE_BASELINE line that has no Test-Weakened line", () => {
    const h = history();
    try {
      const raised = h.commit("chore: room", { [guard.SIZE_PIN.file]: h.pins(1700) });
      const red = h.judge(raised);
      expect(red.status, red.out).toBe(1);
      expect(red.out).toContain(`${guard.SIZE_PIN.file} ${guard.SIZE_PIN.name} src/big.ts 1650 -> 1700`);
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });
});
