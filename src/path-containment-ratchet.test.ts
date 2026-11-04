/**
 * Detector for docs/contracts/path-containment.md, rule no-hand-rolled-containment.
 *
 * "Is this path inside that root?" has one producer: src/common/path-containment.ts.
 * When the contract was written the repo answered it by hand in at least 43
 * files (counting only the shapes below), and
 * the copies disagreed (see the contract). Rewriting every one of them at once
 * meant touching security code in forty places in one change, so this is a
 * RATCHET: the files below may keep the count they had, no file may grow one,
 * and a file whose count drops must lower its line here in the same change —
 * so the number only ever goes down.
 *
 * The idioms are the shapes the copies were written in. A line is counted once
 * however many of them it holds; comment lines are not counted. The counts are
 * therefore a FLOOR — what these shapes see, not every hand-rolled check. Known
 * blind spots are listed in the contract (a bare `x.startsWith(root)`, a bare
 * `.includes("..")` on a relative step, a prefix built on one line and tested
 * on the next); a new shape seen in the wild belongs in IDIOMS.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const PRODUCER = "src/common/path-containment.ts";

const IDIOMS: readonly RegExp[] = [
  // relative(root, x).startsWith(`..${sep}`)
  /startsWith\(\s*`\.\.\$\{/,
  // relative(root, x).startsWith("..") / ("../") / ("..\\")
  /startsWith\(\s*['"]\.\.(?:['"/]|\\\\)/,
  // x.startsWith(root + sep)
  /startsWith\(\s*[A-Za-z_$][\w$.]*\s*\+\s*(?:[\w$]+\.)?(?:sep|pathSep|SEP)\s*\)/,
  // x.startsWith(`${root}${sep}`)
  /startsWith\(\s*`\$\{[^}]+\}\$\{(?:[\w$]+\.)?(?:sep|pathSep|SEP)\}`\s*\)/,
  // root.endsWith(sep) ? root : root + sep
  /endsWith\(\s*(?:[\w$]+\.)?(?:sep|pathSep|SEP)\s*\)\s*\?/,
  // step.split(/[\\/]/)[0] !== ".." — a first-segment climb test
  /\[0\]\s*[!=]==\s*['"]\.\.['"]/,
  // step.split(/[\\/]/).includes("..") — an any-segment climb test
  /\.split\([^)]*\)\.includes\(\s*['"]\.\.['"]\s*\)/,
];

/**
 * Hand-rolled containment lines per file, as IDIOMS sees them (a floor, not
 * the true count). 2026-11-04: 64 lines in 43 files before the producer
 * existed; 58 in 39 once the first six copies moved to it. Lower a count when
 * you migrate a file; delete its line at zero. Never raise one, never add one
 * — except when IDIOMS itself widens, and then say so in the commit.
 */
const BASELINE: Readonly<Record<string, number>> = {
  "src/agents/autonomy/project-shell-allowlist.ts": 1,
  "src/agents/context/strada-knowledge.ts": 1,
  "src/agents/multi/workspace-change-review.ts": 2,
  "src/agents/multi/workspace-lease-manager.ts": 1,
  "src/agents/plugins/plugin-loader.ts": 2,
  "src/agents/soul/soul-loader.ts": 3,
  "src/agents/tools/dynamic/create-skill.ts": 1,
  "src/agents/tools/file-manage.ts": 2,
  "src/agents/tools/file-write.ts": 1,
  "src/agents/tools/git-internals-guard.ts": 1,
  "src/agents/tools/search.ts": 1,
  "src/agents/tools/shell-sensitive-paths.ts": 1,
  "src/agents/tools/speech-to-text.ts": 1,
  "src/agents/tools/unity/generated-asset-guard.ts": 1,
  "src/agents/tools/unity/meta-file-utils.ts": 1,
  "src/agents/tools/vault-write-note-tool.ts": 1,
  "src/bench/swe-sharp-runner.ts": 1,
  "src/campaign/evidence-ledger.ts": 1,
  "src/campaign/playthrough-verdict.ts": 1,
  "src/channels/web/channel.ts": 1,
  "src/core/auto-updater.ts": 1,
  "src/core/database-backup.ts": 6,
  "src/core/setup-wizard.ts": 1,
  "src/core/strada-mcp-tool-loader.ts": 2,
  "src/daemon/deployment/validate-script-path.ts": 2,
  "src/daemon/triggers/file-watch-trigger.ts": 1,
  "src/dashboard/workspace-routes.ts": 1,
  "src/intelligence/unity-guid-resolver.ts": 1,
  "src/learning/error-signature.ts": 1,
  "src/rag/docs/doc-rag-pipeline.ts": 1,
  "src/rag/file-pattern.ts": 1,
  "src/security/framework-package-path.ts": 1,
  "src/security/path-guard.ts": 5,
  "src/skills/skill-import-scan.ts": 1,
  "src/skills/skill-trust.ts": 1,
  "src/vault/path-policy.ts": 3,
  "src/vault/vault-registry.ts": 2,
  "src/vault/watcher.ts": 1,
  "src/vault/write-hook.ts": 1,
};

function tsSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsSources(full, out);
    else if (/\.ts$/.test(entry) && !/\.(test|spec)\.ts$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

function measure(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of tsSources(SRC_DIR)) {
    const shown = `src/${relative(SRC_DIR, file).split(sep).join("/")}`;
    if (shown === PRODUCER || shown.startsWith("src/tests/")) continue;
    let n = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      if (IDIOMS.some((re) => re.test(line))) n++;
    }
    if (n > 0) counts[shown] = n;
  }
  return counts;
}

describe("path containment ratchet (docs/contracts/path-containment.md)", () => {
  const measured = measure();

  it("no file outside the baseline hand-rolls a containment check", () => {
    const fresh = Object.keys(measured).filter((f) => !(f in BASELINE));
    // Use isAtOrInside / isStrictlyInside from src/common/path-containment.ts.
    expect(fresh, "new hand-rolled containment — use src/common/path-containment.ts").toEqual([]);
  });

  it("no baselined file gained one", () => {
    const grown = Object.entries(measured)
      .filter(([f, n]) => f in BASELINE && n > BASELINE[f]!)
      .map(([f, n]) => `${f}: ${BASELINE[f]} -> ${n}`);
    expect(grown, "use src/common/path-containment.ts instead of adding a copy").toEqual([]);
  });

  it("the baseline is lowered as soon as a file is migrated", () => {
    const stale = Object.entries(BASELINE)
      .filter(([f, n]) => (measured[f] ?? 0) < n)
      .map(([f, n]) => `${f}: baseline ${n}, now ${measured[f] ?? 0}`);
    expect(stale, "lower these lines in BASELINE (delete at zero) so the ratchet holds").toEqual([]);
  });
});
