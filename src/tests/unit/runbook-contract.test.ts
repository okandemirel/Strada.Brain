/**
 * THE RUNBOOK MUST NAME COMMANDS THAT EXIST.
 *
 * A runbook is read by someone who is already in trouble: a command that does
 * not exist, or an npm script whose name drifted, costs them the one thing they
 * do not have. The checks section was added because `accept:release` and
 * `restore:db` shipped undocumented — this test is what keeps the other
 * direction from happening (documented, then renamed away).
 *
 * Asserted over the text and the manifest, never executed: each of these
 * performs real installs, restores or provider work, which belongs in their own
 * runners, not in the unit suite.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const runbook = readFileSync(join(repoRoot, "docs", "RUNBOOK.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** The first cell of every table row whose command is in backticks. */
function documentedCommands(): string[] {
  return runbook
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.split("|")[1]!.trim().replace(/`/g, ""))
    .filter((cell) => cell.startsWith("npm run ") || cell.startsWith("node "));
}

describe("the runbook's checks section (plan 6.8/6.13)", () => {
  it("documents every check an operator is expected to be able to run", () => {
    const commands = documentedCommands();
    for (const expected of [
      "npm run smoke:boot",
      "node scripts/ci/first-run-rehearsal.mjs",
      "npm run accept:release",
      "node scripts/eval/learning-eval.mjs --ablation-only",
    ]) {
      expect(commands.some((c) => c.startsWith(expected)), expected).toBe(true);
    }
    expect(commands.some((c) => c.startsWith("npm run restore:db"))).toBe(true);
  });

  it("names only npm scripts that exist and files that are on disk", () => {
    for (const command of documentedCommands()) {
      if (command.startsWith("npm run ")) {
        const script = command.slice("npm run ".length).split(" ")[0]!;
        expect(pkg.scripts[script], `npm script ${script}`).toBeDefined();
      } else {
        const file = command.slice("node ".length).split(" ")[0]!;
        expect(existsSync(join(repoRoot, file)), file).toBe(true);
      }
    }
  });

  it("states the exit-code contract, and that an unrun step is never a pass", () => {
    const flat = runbook.replace(/\s+/gu, " ");
    expect(flat).toContain("**3** something the run needed did NOT run");
    expect(flat).toMatch(/unproven, never accepted/i);
    // The two honesty rules the runners share.
    expect(flat).toContain("a pre-registered budget is never moved");
    expect(flat).toContain("a step that did not run is never folded into a pass");
  });

  it("says out loud that the ablation harness currently exits 1, and why", () => {
    const flat = runbook.replace(/\s+/gu, " ");
    // A red measure that the runbook calls green is worse than no runbook.
    expect(flat).toContain("0.40");
    expect(flat).toContain("0.34");
    expect(flat).toMatch(/real open finding/i);
  });
});
