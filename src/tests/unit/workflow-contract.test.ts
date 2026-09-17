/**
 * CI workflow contract (14F6 / D75).
 *
 * THESE FIVE TESTS ARE RED ON PURPOSE UNTIL THE WORKFLOW FILES LAND.
 * The change they describe was written and reviewed here, but the push that
 * carried everything else was refused for the two files under
 * .github/workflows: GitHub will not let this OAuth app create or update a
 * workflow without the `workflow` scope. The diff is saved at
 * ~/Desktop/strada-workflow-changes.patch — `git apply` it and commit from an
 * account that has the scope, and these tests go green. Skipping them instead
 * would turn a real, unlanded change into a green suite, which is the exact
 * failure this project keeps closing.
 *
 * Two holes this closes:
 *   - CI type-checked, linted, tested and built, but never started what it
 *     built. `npm run smoke:boot` existed and nothing ran it, so a boot-time
 *     crash went green.
 *   - Version Bump triggered on `push` to main, independently of CI. A commit
 *     that failed every job still got a version bump, published as if it were a
 *     release candidate. The bump must depend on the CI run for that commit.
 *
 * Asserted over the workflow YAML as text (no YAML parser is a dependency
 * here); the properties are which job runs what, and what triggers the bump.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (name: string): string =>
  readFileSync(path.join(repoRoot, ".github", "workflows", name), "utf8");

const ci = read("ci.yml");
const bump = read("version-bump.yml");

/** The block of a top-level `jobs:` entry, by name. */
function jobBlock(workflow: string, job: string): string {
  const start = workflow.indexOf(`\n  ${job}:`);
  expect(start, `job ${job} is not defined`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("ci.yml", () => {
  it("has a smoke job that actually boots the build", () => {
    const smoke = jobBlock(ci, "smoke");
    expect(smoke).toMatch(/npm run build/);
    expect(smoke).toMatch(/npm run smoke:boot/);
  });

  it("gives the smoke job its own runner, so a boot failure is attributable", () => {
    expect(ci).toMatch(/\n {2}smoke:\n/);
    const smoke = jobBlock(ci, "smoke");
    expect(smoke).toMatch(/runs-on:/);
    expect(smoke).toMatch(/timeout-minutes:/);
  });

  it("is named CI — the version bump keys its workflow_run on that name", () => {
    expect(ci).toMatch(/^name: CI$/m);
  });
});

describe("version-bump.yml", () => {
  it("runs after the CI workflow instead of on every push", () => {
    expect(bump).toMatch(/on:\s*\n\s*workflow_run:/);
    expect(bump).toMatch(/workflows:\s*\["?CI"?\]/);
    expect(bump).toMatch(/types:\s*\[completed\]/);
    // A bare `push:` trigger is what made the bump independent of CI.
    expect(bump).not.toMatch(/^\s{2}push:/m);
  });

  it("bumps only when that CI run succeeded", () => {
    const job = jobBlock(bump, "bump");
    expect(job).toMatch(/github\.event\.workflow_run\.conclusion == 'success'/);
    // And still skips its own [skip ci] bump commit, or it loops forever.
    expect(job).toMatch(/workflow_run\.head_commit\.message, '\[skip ci\]'/);
  });

  it("bumps the commit CI verified, not whatever main points at now", () => {
    const job = jobBlock(bump, "bump");
    expect(job).toMatch(/ref: \$\{\{ github\.event\.workflow_run\.head_branch \}\}/);
  });
});
