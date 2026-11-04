/**
 * Detector for docs/contracts/governance.md, rule governed-change-says-why.
 *
 * No person reviews a push here, so a change to the files that enforce the
 * rules must carry its reason (a Governance-Change: line). The checker that
 * judges a push also has to be the one from the base commit, so that a push
 * cannot loosen the checker and pass under the loosened checker.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

interface Guard {
  GOVERNED: RegExp[];
  governedChanges(paths: string[]): string[];
  judgeCommit(input: {
    message: string;
    files: never[];
    sourceChanged: boolean;
    pins: never[];
    changedPaths: string[];
  }): { governed: string[]; governanceReason: string | null };
}
const guard = (await import(pathToFileURL(join(REPO, "scripts/ci/check-test-integrity.mjs")).href)) as Guard;

const judge = (message: string, changedPaths: string[]) =>
  guard.judgeCommit({ message, files: [], sourceChanged: true, pins: [], changedPaths });

describe("a change to the rules says why (docs/contracts/governance.md)", () => {
  it("governs the checker itself, the hooks, the installer, the workflows, the contracts and their checker", () => {
    const governed = guard.governedChanges([
      "scripts/ci/check-test-integrity.mjs",
      "scripts/git-hooks/pre-push",
      "scripts/install-git-hooks.mjs",
      ".github/workflows/ci.yml",
      "docs/contracts/file-size.md",
      "src/contracts.test.ts",
    ]);
    expect(governed).toHaveLength(6);
  });

  it("does not govern records: the contracts' index, team memory, ordinary source", () => {
    expect(
      guard.governedChanges(["docs/contracts/README.md", "docs/memory/INDEX.md", "src/campaign/campaign-manager.ts"]),
    ).toEqual([]);
  });

  it("names the governed files a commit changed, and accepts only a sentence of reason", () => {
    const silent = judge("ci: tweak\n", [".github/workflows/ci.yml", "src/x.ts"]);
    expect(silent.governed).toEqual([".github/workflows/ci.yml"]);
    expect(silent.governanceReason).toBeNull();
    expect(judge("ci: tweak\n\nGovernance-Change: ok\n", [".github/workflows/ci.yml"]).governanceReason).toBeNull();
    const said = judge(
      "ci: tweak\n\nGovernance-Change: the audit step now allows dated, path-bound exceptions instead of failing on all of them.\n",
      [".github/workflows/ci.yml"],
    );
    expect(said.governanceReason).toMatch(/^Governance-Change: the audit step/);
  });

  it("CI judges a push with the checker from its base commit, not from the push", () => {
    const ci = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain('git show "$BASE_SHA:$GUARD"');
    expect(ci).toContain('node "$GUARD" --base "$BASE_SHA"');
  });

  it("the pre-push hook runs the remote's copy of the checker too", () => {
    const hook = readFileSync(join(REPO, "scripts/git-hooks/pre-push"), "utf8");
    expect(hook).toContain('git show "$base:$guard"');
  });
});
